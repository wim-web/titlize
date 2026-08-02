import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, shouldUpdate } from "../src/state-store";

const stores: StateStore[] = [];

function openStore(path = join(mkdtempSync(join(tmpdir(), "titlize-state-")), "nested", "state.sqlite3")) {
  const store = new StateStore(path);
  stores.push(store);
  return { store, path };
}

function closeStore(store: StateStore): void {
  const index = stores.indexOf(store);
  if (index !== -1) stores.splice(index, 1);
  store.close();
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe("StateStore", () => {
  test("親ディレクトリを作成して初回 Stop を記録する", () => {
    const { store, path } = openStore();

    const result = store.recordStop("s1", "t1", "2026-08-01T00:00:00.000Z");

    expect(existsSync(path)).toBe(true);
    expect(result).toEqual({
      isNewTurn: true,
      state: {
        sessionId: "s1",
        stopCount: 1,
        lastTurnId: "t1",
        pendingUpdate: false,
        lastAutoTitle: null,
        pendingTitle: null,
        pendingPreviousTitle: null,
        pendingPreviousTitleKnown: false,
        autoUpdateDisabled: false,
        lastSuccessAt: null,
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    });
  });

  test("同一 turn は二重加算せず、次 turn だけを加算する", () => {
    const { store } = openStore();
    store.recordStop("s1", "t1", "first");

    expect(store.recordStop("s1", "t1", "duplicate")).toEqual({
      isNewTurn: false,
      state: expect.objectContaining({ stopCount: 1, updatedAt: "first" }),
    });
    expect(store.recordStop("s1", "t2", "second")).toEqual({
      isNewTurn: true,
      state: expect.objectContaining({ stopCount: 2, lastTurnId: "t2", updatedAt: "second" }),
    });
  });

  test("非連続に再送された古い turn も二重加算しない", () => {
    const { store } = openStore();
    store.recordStop("s1", "t1", "first");
    store.recordStop("s1", "t2", "second");

    expect(store.recordStop("s1", "t1", "replayed")).toEqual({
      isNewTurn: false,
      state: expect.objectContaining({ stopCount: 2, lastTurnId: "t2", updatedAt: "second" }),
    });
  });

  test("同じ DB の2接続から同一 turn を記録しても一度だけ加算する", () => {
    const path = join(mkdtempSync(join(tmpdir(), "titlize-state-")), "state.sqlite3");
    const first = openStore(path).store;
    const second = openStore(path).store;

    expect(first.recordStop("s1", "t1", "first").isNewTurn).toBe(true);
    expect(second.recordStop("s1", "t1", "second")).toEqual({
      isNewTurn: false,
      state: expect.objectContaining({ stopCount: 1, updatedAt: "first" }),
    });
  });

  test("4つの Bun プロセスが同じ turn を同時記録しても一度だけ加算する", async () => {
    const directory = mkdtempSync(join(tmpdir(), "titlize-state-workers-"));
    const databasePath = join(directory, "state.sqlite3");
    const gatePath = join(directory, "start");
    const helperPath = join(import.meta.dir, "helpers", "record-stop-worker.ts");
    const setup = openStore(databasePath).store;
    closeStore(setup);
    const workers = Array.from({ length: 4 }, (_, index) => {
      const readyPath = join(directory, `ready-${index}`);
      return Bun.spawn({
        cmd: [process.execPath, helperPath, databasePath, "s1", "t1", gatePath, readyPath],
        stdout: "pipe",
        stderr: "pipe",
      });
    });

    let released = false;
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (workers.every((_, index) => existsSync(join(directory, `ready-${index}`)))) break;
        await Bun.sleep(10);
      }
      expect(workers.every((_, index) => existsSync(join(directory, `ready-${index}`)))).toBe(true);

      writeFileSync(gatePath, "go");
      released = true;
      const results = await Promise.all(workers.map(async (worker) => ({
        exitCode: await worker.exited,
        stdout: await new Response(worker.stdout).text(),
        stderr: await new Response(worker.stderr).text(),
      })));

      if (results.some((result) => result.exitCode !== 0)) {
        throw new Error(`Worker failed: ${JSON.stringify(results)}`);
      }
      expect(results.map((result) => result.stderr)).toEqual(["", "", "", ""]);
      expect(results.map((result) => JSON.parse(result.stdout).isNewTurn).filter(Boolean)).toHaveLength(1);

      const { store } = openStore(databasePath);
      expect(store.getSession("s1")).toEqual(expect.objectContaining({ stopCount: 1, lastTurnId: "t1" }));
    } finally {
      if (!released) writeFileSync(gatePath, "go");
      await Promise.all(workers.map((worker) => worker.exited));
    }
  });

  test("セッションの状態を完全に分離する", () => {
    const { store } = openStore();
    store.recordStop("s1", "t1", "one");
    store.markPending("s1", "pending");
    store.recordStop("s2", "t1", "two");

    expect(store.getSession("s1")).toEqual(expect.objectContaining({ stopCount: 1, pendingUpdate: true }));
    expect(store.getSession("s2")).toEqual(expect.objectContaining({ stopCount: 1, pendingUpdate: false }));
  });

  test("markPending は未知セッションを作成し、既存フィールドを保持する", () => {
    const { store } = openStore();
    expect(store.markPending("new", "now")).toEqual({
      sessionId: "new", stopCount: 0, lastTurnId: null, pendingUpdate: true,
      lastAutoTitle: null, pendingTitle: null, pendingPreviousTitle: null,
      pendingPreviousTitleKnown: false, autoUpdateDisabled: false,
      lastSuccessAt: null, updatedAt: "now",
    });
    store.markSuccess("new", "old title", "success");

    expect(store.markPending("new", "retry")).toEqual(expect.objectContaining({
      stopCount: 0, pendingUpdate: true, lastAutoTitle: "old title", lastSuccessAt: "success", updatedAt: "retry",
    }));
  });

  test("markSuccess は成功情報を保存して自動更新停止を保持する", () => {
    const { store } = openStore();
    store.markAutoUpdateDisabled("s1", "disabled");

    expect(store.markSuccess("s1", "title", "success")).toEqual(expect.objectContaining({
      pendingUpdate: false, lastAutoTitle: "title", lastSuccessAt: "success",
      autoUpdateDisabled: true, updatedAt: "success",
    }));
  });

  test("markForcedSuccess は未知セッションを直接 upsert して成功情報を保存する", () => {
    const { store } = openStore();

    expect(store.markForcedSuccess("new", "forced", "forced-at")).toEqual({
      sessionId: "new", stopCount: 0, lastTurnId: null, pendingUpdate: false,
      lastAutoTitle: "forced", pendingTitle: null, pendingPreviousTitle: null,
      pendingPreviousTitleKnown: false, autoUpdateDisabled: false,
      lastSuccessAt: "forced-at", updatedAt: "forced-at",
    });
  });

  test("markForcedSuccess は既存セッションの自動更新停止を解除する", () => {
    const { store } = openStore();
    store.markAutoUpdateDisabled("s1", "disabled");

    expect(store.markForcedSuccess("s1", "forced", "forced-at")).toEqual(expect.objectContaining({
      stopCount: 0, lastTurnId: null, pendingUpdate: false, lastAutoTitle: "forced",
      lastSuccessAt: "forced-at", autoUpdateDisabled: false, updatedAt: "forced-at",
    }));
  });

  test("markAutoUpdateDisabled は保留を消して既存フィールドを保持する", () => {
    const { store } = openStore();
    store.recordStop("s1", "t1", "stop");
    store.markPending("s1", "pending");
    store.markSuccess("s1", "title", "success");

    expect(store.markAutoUpdateDisabled("s1", "disabled")).toEqual(expect.objectContaining({
      stopCount: 1, lastTurnId: "t1", pendingUpdate: false, autoUpdateDisabled: true,
      lastAutoTitle: "title", lastSuccessAt: "success", updatedAt: "disabled",
    }));
  });

  test("pending更新から同一turnのタイトル確認と書込みを相関して成功を記録する", () => {
    const { store } = openStore();
    store.markPending("s1", "pending");

    expect(store.beginRenameAttempt("s1", "turn-1", "attempt")).toBe("started");
    expect(store.beginRenameAttempt("s1", "turn-1", "duplicate")).toBe("ignored");
    expect(store.isTitleReadExpected("s1", "turn-1")).toBe(true);
    expect(store.observeCurrentTitle("s1", "turn-1", "初期", "read")).toBe("authorized");
    expect(store.isTitleReadExpected("s1", "turn-1")).toBe(false);
    expect(store.prepareTitleWrite("s1", "turn-1", "自動", "intent")).toBe("allow");
    expect(store.getSession("s1")).toEqual(expect.objectContaining({
      pendingUpdate: true,
      pendingTitle: "自動",
      pendingPreviousTitle: "初期",
      pendingPreviousTitleKnown: true,
    }));
    expect(store.completeTitleWrite("s1", "turn-1", true, "success")).toBe("success");
    expect(store.getSession("s1")).toEqual(expect.objectContaining({
      pendingUpdate: false,
      pendingTitle: null,
      lastAutoTitle: "自動",
      lastSuccessAt: "success",
    }));
  });

  test("初回はnullを含む現在タイトルを既知baselineとして書込みintentへ保存する", () => {
    const { store } = openStore();
    store.markPending("s1", "pending");
    store.beginRenameAttempt("s1", "turn-1", "attempt");

    expect(store.observeCurrentTitle("s1", "turn-1", null, "read")).toBe("authorized");
    expect(store.prepareTitleWrite("s1", "turn-1", "初回", "intent")).toBe("allow");
    expect(store.getSession("s1")).toEqual(expect.objectContaining({
      pendingPreviousTitle: null,
      pendingPreviousTitleKnown: true,
    }));
  });

  test("前回自動タイトルと現在タイトルが違えば手動変更として停止する", () => {
    const { store } = openStore();
    store.markSuccess("s1", "自動A", "success");
    store.markPending("s1", "pending");
    store.beginRenameAttempt("s1", "turn-1", "attempt");

    expect(store.observeCurrentTitle("s1", "turn-1", "手動M", "read")).toBe("manual_change");
    expect(store.prepareTitleWrite("s1", "turn-1", "自動B", "write")).toBe("deny");
    expect(store.getSession("s1")).toEqual(expect.objectContaining({
      pendingUpdate: false,
      autoUpdateDisabled: true,
      lastAutoTitle: "自動A",
    }));
  });

  test("未確定intentが現在タイトルへ反映済みなら成功として回復する", () => {
    const { store } = openStore();
    store.markSuccess("s1", "自動A", "success-a");
    store.markTitleWritePending("s1", "自動B", "自動A", "intent");
    store.beginRenameAttempt("s1", "turn-2", "attempt");

    expect(store.observeCurrentTitle("s1", "turn-2", "自動B", "read")).toBe("already_applied");
    expect(store.getSession("s1")).toEqual(expect.objectContaining({
      pendingUpdate: false,
      pendingTitle: null,
      lastAutoTitle: "自動B",
      lastSuccessAt: "read",
    }));
  });

  test("未確定intentが書込み前タイトルのままならintentをclearして再書込みを許可する", () => {
    const { store } = openStore();
    store.markSuccess("s1", "自動A", "success-a");
    store.markTitleWritePending("s1", "自動B", "自動A", "intent");
    store.beginRenameAttempt("s1", "turn-2", "attempt");

    expect(store.observeCurrentTitle("s1", "turn-2", "自動A", "read")).toBe("authorized");
    expect(store.prepareTitleWrite("s1", "turn-2", "自動C", "next-intent")).toBe("allow");
    expect(store.getSession("s1")).toEqual(expect.objectContaining({
      pendingTitle: "自動C",
      pendingPreviousTitle: "自動A",
    }));
  });

  test("未確定intentの候補・書込み前タイトルのどちらでもなければ手動変更にする", () => {
    const { store } = openStore();
    store.markSuccess("s1", "自動A", "success-a");
    store.markTitleWritePending("s1", "自動B", "自動A", "intent");
    store.beginRenameAttempt("s1", "turn-2", "attempt");

    expect(store.observeCurrentTitle("s1", "turn-2", "手動M", "read")).toBe("manual_change");
    expect(store.getSession("s1")).toEqual(expect.objectContaining({
      pendingTitle: null,
      autoUpdateDisabled: true,
    }));
  });

  test("attempt外・別turnのツール結果は通常操作として無視する", () => {
    const { store } = openStore();
    store.markPending("s1", "pending");
    store.beginRenameAttempt("s1", "turn-1", "attempt");

    expect(store.observeCurrentTitle("s1", "other", "title", "read")).toBe("ignored");
    expect(store.prepareTitleWrite("s1", "other", "candidate", "write")).toBe("ignored");
    expect(store.completeTitleWrite("s1", "other", true, "done")).toBe("ignored");
  });

  test("タイトル書込みintentを永続化し、通常のpending更新では保持する", () => {
    const { store } = openStore();
    store.recordStop("s1", "t1", "stop");
    store.markSuccess("s1", "old", "success");

    expect(store.markTitleWritePending("s1", "candidate", "before", "intent")).toEqual(
      expect.objectContaining({
        pendingUpdate: true,
        pendingTitle: "candidate",
        pendingPreviousTitle: "before",
        pendingPreviousTitleKnown: true,
        lastAutoTitle: "old",
        updatedAt: "intent",
      }),
    );
    expect(store.markPending("s1", "retry")).toEqual(expect.objectContaining({
      pendingUpdate: true,
      pendingTitle: "candidate",
      pendingPreviousTitle: "before",
      pendingPreviousTitleKnown: true,
      lastAutoTitle: "old",
      updatedAt: "retry",
    }));
  });

  test("タイトル書込みintentはDBを閉じて再接続しても残る", () => {
    const path = join(mkdtempSync(join(tmpdir(), "titlize-state-intent-")), "state.sqlite3");
    const first = openStore(path).store;
    first.markSuccess("s1", "old", "success");
    first.markTitleWritePending("s1", "candidate", null, "intent");
    closeStore(first);

    const second = openStore(path).store;
    expect(second.getSession("s1")).toEqual(expect.objectContaining({
      pendingUpdate: true,
      pendingTitle: "candidate",
      pendingPreviousTitle: null,
      pendingPreviousTitleKnown: true,
      lastAutoTitle: "old",
    }));
  });

  test("書込みintentだけをclearして通常retryのpendingを維持する", () => {
    const { store } = openStore();
    store.markTitleWritePending("s1", "candidate", "before", "intent");

    expect(store.clearTitleWritePending("s1", "clear")).toEqual(expect.objectContaining({
      pendingUpdate: true,
      pendingTitle: null,
      pendingPreviousTitle: null,
      pendingPreviousTitleKnown: false,
      updatedAt: "clear",
    }));
  });

  test.each([
    ["markSuccess", (store: StateStore) => store.markSuccess("s1", "done", "done")],
    ["markForcedSuccess", (store: StateStore) => store.markForcedSuccess("s1", "done", "done")],
    ["markAutoUpdateDisabled", (store: StateStore) => store.markAutoUpdateDisabled("s1", "done")],
  ] as const)("%sは保存済み書込みintentをclearする", (_name, finish) => {
    const { store } = openStore();
    store.markTitleWritePending("s1", "candidate", "before", "intent");

    expect(finish(store)).toEqual(expect.objectContaining({
      pendingTitle: null,
      pendingPreviousTitle: null,
      pendingPreviousTitleKnown: false,
    }));
  });

  test("pending_titleのない旧sessions schemaを既存行を保ったままmigrationする", () => {
    const path = join(mkdtempSync(join(tmpdir(), "titlize-state-legacy-")), "state.sqlite3");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        stop_count INTEGER NOT NULL,
        last_turn_id TEXT,
        pending_update INTEGER NOT NULL,
        last_auto_title TEXT,
        auto_update_disabled INTEGER NOT NULL,
        last_success_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE processed_turns (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        PRIMARY KEY(session_id, turn_id)
      );
      INSERT INTO sessions VALUES (
        'legacy-session', 7, 'legacy-turn', 1, 'legacy-title', 0, 'legacy-success', 'legacy-updated'
      );
      INSERT INTO processed_turns VALUES ('legacy-session', 'legacy-turn');
    `);
    legacy.close();

    const store = openStore(path).store;

    expect(store.getSession("legacy-session")).toEqual({
      sessionId: "legacy-session",
      stopCount: 7,
      lastTurnId: "legacy-turn",
      pendingUpdate: true,
      lastAutoTitle: "legacy-title",
      pendingTitle: null,
      pendingPreviousTitle: null,
      pendingPreviousTitleKnown: false,
      autoUpdateDisabled: false,
      lastSuccessAt: "legacy-success",
      updatedAt: "legacy-updated",
    });
    expect(store.recordStop("legacy-session", "legacy-turn", "duplicate").isNewTurn).toBe(false);
    expect(store.markTitleWritePending("legacy-session", "new-title", "legacy-title", "intent")).toEqual(
      expect.objectContaining({
        stopCount: 7,
        pendingTitle: "new-title",
        pendingPreviousTitle: "legacy-title",
        pendingPreviousTitleKnown: true,
      }),
    );
  });

  test("pending_titleだけを持つ旧schemaをintentを失わずmigrationする", () => {
    const path = join(mkdtempSync(join(tmpdir(), "titlize-state-intermediate-")), "state.sqlite3");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        stop_count INTEGER NOT NULL,
        last_turn_id TEXT,
        pending_update INTEGER NOT NULL,
        last_auto_title TEXT,
        pending_title TEXT,
        auto_update_disabled INTEGER NOT NULL,
        last_success_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE processed_turns (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        PRIMARY KEY(session_id, turn_id)
      );
      INSERT INTO sessions VALUES
        ('legacy-known', 3, 't3', 1, 'A', 'candidate-b', 0, NULL, 'known-updated'),
        ('legacy-unknown', 5, 't5', 1, NULL, 'candidate-c', 0, NULL, 'unknown-updated');
    `);
    legacy.close();

    const store = openStore(path).store;

    expect(store.getSession("legacy-known")).toEqual({
      sessionId: "legacy-known",
      stopCount: 3,
      lastTurnId: "t3",
      pendingUpdate: true,
      lastAutoTitle: "A",
      pendingTitle: "candidate-b",
      pendingPreviousTitle: "A",
      pendingPreviousTitleKnown: true,
      autoUpdateDisabled: false,
      lastSuccessAt: null,
      updatedAt: "known-updated",
    });
    expect(store.getSession("legacy-unknown")).toEqual({
      sessionId: "legacy-unknown",
      stopCount: 5,
      lastTurnId: "t5",
      pendingUpdate: true,
      lastAutoTitle: null,
      pendingTitle: "candidate-c",
      pendingPreviousTitle: null,
      pendingPreviousTitleKnown: false,
      autoUpdateDisabled: false,
      lastSuccessAt: null,
      updatedAt: "unknown-updated",
    });
  });

  test("known列のない前世代schemaも復元可能なbaselineだけを既知としてmigrationする", () => {
    const path = join(mkdtempSync(join(tmpdir(), "titlize-state-previous-")), "state.sqlite3");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        stop_count INTEGER NOT NULL,
        last_turn_id TEXT,
        pending_update INTEGER NOT NULL,
        last_auto_title TEXT,
        pending_title TEXT,
        pending_previous_title TEXT,
        auto_update_disabled INTEGER NOT NULL,
        last_success_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE processed_turns (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        PRIMARY KEY(session_id, turn_id)
      );
      INSERT INTO sessions VALUES
        ('backfilled', 7, 't7', 1, 'A', 'B', NULL, 0, NULL, 'backfilled-at'),
        ('preserved', 8, 't8', 1, 'A', 'B', 'M', 1, NULL, 'preserved-at'),
        ('unknown', 9, 't9', 1, NULL, 'B', NULL, 0, NULL, 'unknown-at');
    `);
    legacy.close();

    const store = openStore(path).store;

    expect(store.getSession("backfilled")).toEqual(expect.objectContaining({
      stopCount: 7,
      pendingTitle: "B",
      pendingPreviousTitle: "A",
      pendingPreviousTitleKnown: true,
    }));
    expect(store.getSession("preserved")).toEqual(expect.objectContaining({
      stopCount: 8,
      pendingTitle: "B",
      pendingPreviousTitle: "M",
      pendingPreviousTitleKnown: true,
      autoUpdateDisabled: true,
    }));
    expect(store.getSession("unknown")).toEqual(expect.objectContaining({
      stopCount: 9,
      pendingTitle: "B",
      pendingPreviousTitle: null,
      pendingPreviousTitleKnown: false,
    }));
  });

  test("close 後の DB 操作は閉鎖済み接続として失敗する", () => {
    const { store } = openStore();
    closeStore(store);

    expect(() => store.getSession("s1")).toThrow();
    expect(() => store.markPending("s1", "now")).toThrow();
  });

  test("read-only DBでPRAGMA初期化が失敗しても接続を閉じ元のエラーを保つ", () => {
    const path = join(mkdtempSync(join(tmpdir(), "titlize-state-readonly-")), "state.sqlite3");
    const setup = new Database(path);
    setup.exec("CREATE TABLE marker (id INTEGER)");
    setup.close();
    let opened: Database | undefined;
    let failure: unknown;

    try {
      new StateStore(path, {
        openDatabase(databasePath) {
          opened = new Database(databasePath, { readonly: true });
          return opened;
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("readonly");
    const openedDatabase = opened;
    expect(openedDatabase).toBeDefined();
    if (openedDatabase === undefined) throw new Error("test database was not opened");
    expect(() => openedDatabase.query("SELECT 1").get()).toThrow();
  });
});

describe("shouldUpdate", () => {
  test("pending は周期外でも再試行する", () => {
    expect(shouldUpdate({ stopCount: 4, pendingUpdate: true }, 3)).toBe(true);
  });

  test("N回目だけを更新対象にする", () => {
    expect(shouldUpdate({ stopCount: 2, pendingUpdate: false }, 3)).toBe(false);
    expect(shouldUpdate({ stopCount: 3, pendingUpdate: false }, 3)).toBe(true);
  });

  test("0 Stop と不正な周期は更新しない", () => {
    expect(shouldUpdate({ stopCount: 0, pendingUpdate: false }, 3)).toBe(false);
    expect(shouldUpdate({ stopCount: 3, pendingUpdate: true }, 0)).toBe(false);
    expect(shouldUpdate({ stopCount: 3, pendingUpdate: true }, -1)).toBe(false);
  });
});

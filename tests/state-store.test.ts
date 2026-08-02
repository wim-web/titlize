import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { shouldUpdate, StateStore } from "../src/state-store";

const stores: StateStore[] = [];
const directories: string[] = [];

function openStore(path = ":memory:"): { store: StateStore; path: string } {
  const store = new StateStore(path);
  stores.push(store);
  return { store, path };
}

function closeStore(store: StateStore): void {
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
  store.close();
}

function temporaryDatabasePath(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return join(directory, "state.sqlite3");
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("recordStop", () => {
  test("新しい turn ごとに stop_count を加算する", () => {
    const { store } = openStore();

    expect(store.recordStop("s1", "t1", "first")).toEqual({
      isNewTurn: true,
      state: expect.objectContaining({ stopCount: 1, lastTurnId: "t1", updatedAt: "first" }),
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
    const path = temporaryDatabasePath("titlize-state-");
    const first = openStore(path).store;
    const second = openStore(path).store;

    expect(first.recordStop("s1", "t1", "first").isNewTurn).toBe(true);
    expect(second.recordStop("s1", "t1", "second")).toEqual({
      isNewTurn: false,
      state: expect.objectContaining({ stopCount: 1, updatedAt: "first" }),
    });
  });

  test("4つの Bun プロセスが同じ turn を同時記録しても一度だけ加算する", async () => {
    const databasePath = temporaryDatabasePath("titlize-state-workers-");
    const directory = dirname(databasePath);
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
});

describe("セッション状態の更新", () => {
  test("markPending は未知セッションを作成し、既存フィールドを保持する", () => {
    const { store } = openStore();
    expect(store.markPending("new", "now")).toEqual({
      sessionId: "new",
      stopCount: 0,
      lastTurnId: null,
      pendingUpdate: true,
      lastAutoTitle: null,
      autoUpdateDisabled: false,
      lastSuccessAt: null,
      updatedAt: "now",
    });

    store.adoptAutoTitle("new", "自動A", "adopted");
    store.markPending("new", "again");
    expect(store.getSession("new")).toEqual(expect.objectContaining({
      pendingUpdate: true,
      lastAutoTitle: "自動A",
      lastSuccessAt: "adopted",
    }));
  });

  test("markAutoUpdateDisabled は pending と書込み予約を消して停止する", () => {
    const { store } = openStore();
    store.markPending("s1", "pending");
    store.beginPendingWrite("s1", "t1", "基準", "begin");

    expect(store.markAutoUpdateDisabled("s1", "disabled")).toEqual(expect.objectContaining({
      pendingUpdate: false,
      autoUpdateDisabled: true,
    }));
    expect(store.getPendingWrite("s1")).toBeUndefined();
  });

  test("adoptAutoTitle は成功情報を保存して書込み予約を消す", () => {
    const { store } = openStore();
    store.markPending("s1", "pending");
    store.beginPendingWrite("s1", "t1", "基準", "begin");

    expect(store.adoptAutoTitle("s1", "自動A", "adopted")).toEqual(expect.objectContaining({
      pendingUpdate: false,
      lastAutoTitle: "自動A",
      lastSuccessAt: "adopted",
      updatedAt: "adopted",
    }));
    expect(store.getPendingWrite("s1")).toBeUndefined();
  });
});

describe("pending_writes", () => {
  test("beginPendingWrite は同一セッションの予約を上書きする", () => {
    const { store } = openStore();
    store.markPending("s1", "pending");

    store.beginPendingWrite("s1", "t1", "基準A", "first");
    store.beginPendingWrite("s1", "t2", "基準B", "second");

    expect(store.getPendingWrite("s1")).toEqual({
      sessionId: "s1",
      turnId: "t2",
      baselineTitle: "基準B",
      updatedAt: "second",
    });
  });

  test("空文字の基準タイトルも保持できる", () => {
    const { store } = openStore();
    store.markPending("s1", "pending");
    store.beginPendingWrite("s1", "t1", "", "begin");

    expect(store.getPendingWrite("s1")).toEqual(expect.objectContaining({ baselineTitle: "" }));
  });

  test("clearPendingWrite は該当セッションのみ削除する", () => {
    const { store } = openStore();
    store.markPending("s1", "pending");
    store.markPending("s2", "pending");
    store.beginPendingWrite("s1", "t1", "基準1", "begin");
    store.beginPendingWrite("s2", "t1", "基準2", "begin");

    store.clearPendingWrite("s1");

    expect(store.getPendingWrite("s1")).toBeUndefined();
    expect(store.getPendingWrite("s2")).toEqual(expect.objectContaining({ baselineTitle: "基準2" }));
  });

  test("予約は同一DBの別接続からも見える", () => {
    const path = temporaryDatabasePath("titlize-state-shared-");
    const first = openStore(path).store;
    const second = openStore(path).store;
    first.markPending("s1", "pending");
    first.beginPendingWrite("s1", "t1", "基準", "begin");

    expect(second.getPendingWrite("s1")).toEqual(expect.objectContaining({
      turnId: "t1",
      baselineTitle: "基準",
    }));
  });
});

describe("旧スキーマからの移行", () => {
  test("handshake世代のDBを開くとrename_attemptsを破棄しsessionsを保持する", () => {
    const path = temporaryDatabasePath("titlize-state-legacy-");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        stop_count INTEGER NOT NULL CHECK(stop_count >= 0),
        last_turn_id TEXT,
        pending_update INTEGER NOT NULL CHECK(pending_update IN (0, 1)),
        last_auto_title TEXT,
        pending_title TEXT,
        pending_previous_title TEXT,
        pending_previous_title_known INTEGER NOT NULL DEFAULT 0
          CHECK(pending_previous_title_known IN (0, 1)),
        auto_update_disabled INTEGER NOT NULL CHECK(auto_update_disabled IN (0, 1)),
        last_success_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE processed_turns (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        PRIMARY KEY(session_id, turn_id),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      );
      CREATE TABLE rename_attempts (
        session_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        observed_title TEXT,
        observed_title_known INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      );
      INSERT INTO sessions VALUES (
        'legacy-session', 7, 'legacy-turn', 1, 'legacy-title',
        '滞留候補', NULL, 0, 0, 'legacy-success', 'legacy-updated'
      );
      INSERT INTO processed_turns VALUES ('legacy-session', 'legacy-turn');
      INSERT INTO rename_attempts VALUES
        ('legacy-session', 'stuck-turn', 'awaiting_read', NULL, 0, 'stuck-at');
    `);
    legacy.close();

    const { store } = openStore(path);

    expect(store.getSession("legacy-session")).toEqual({
      sessionId: "legacy-session",
      stopCount: 7,
      lastTurnId: "legacy-turn",
      pendingUpdate: true,
      lastAutoTitle: "legacy-title",
      autoUpdateDisabled: false,
      lastSuccessAt: "legacy-success",
      updatedAt: "legacy-updated",
    });
    expect(store.getPendingWrite("legacy-session")).toBeUndefined();

    // The new tables and writes work on the migrated database.
    store.beginPendingWrite("legacy-session", "t-new", "基準", "begin");
    expect(store.getPendingWrite("legacy-session")).toEqual(
      expect.objectContaining({ turnId: "t-new" }),
    );
    expect(store.recordStop("legacy-session", "t-next", "next").state.stopCount).toBe(8);

    const raw = new Database(path, { readonly: true });
    try {
      const tables = raw
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rename_attempts'",
        )
        .all();
      expect(tables).toHaveLength(0);
    } finally {
      raw.close();
    }
  });
});

describe("shouldUpdate", () => {
  test("pending か stop_count が every の倍数のとき更新する", () => {
    expect(shouldUpdate({ stopCount: 3, pendingUpdate: false }, 3)).toBe(true);
    expect(shouldUpdate({ stopCount: 4, pendingUpdate: false }, 3)).toBe(false);
    expect(shouldUpdate({ stopCount: 4, pendingUpdate: true }, 3)).toBe(true);
    expect(shouldUpdate({ stopCount: 0, pendingUpdate: false }, 3)).toBe(false);
    expect(shouldUpdate({ stopCount: 3, pendingUpdate: true }, 0)).toBe(false);
  });
});

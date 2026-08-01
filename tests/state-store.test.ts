import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
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
      lastAutoTitle: null, autoUpdateDisabled: false, lastSuccessAt: null, updatedAt: "now",
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
      lastAutoTitle: "forced", autoUpdateDisabled: false, lastSuccessAt: "forced-at", updatedAt: "forced-at",
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

  test("close 後の DB 操作は閉鎖済み接続として失敗する", () => {
    const { store } = openStore();
    closeStore(store);

    expect(() => store.getSession("s1")).toThrow();
    expect(() => store.markPending("s1", "now")).toThrow();
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

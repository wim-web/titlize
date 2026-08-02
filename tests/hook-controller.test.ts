import { afterEach, describe, expect, test } from "bun:test";
import type { AppTitleReader, TitleReadResult } from "../src/app-db";
import {
  HookController,
  SET_THREAD_TITLE_TOOL_NAME,
  type HookLogCode,
  type HookOutput,
  type HookStateStore,
} from "../src/hook-controller";
import { StateStore } from "../src/state-store";

const NOW = "2026-08-02T01:02:03.000Z";
const stores: StateStore[] = [];

function openStore(): StateStore {
  const store = new StateStore(":memory:");
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

class FakeTitleReader implements AppTitleReader {
  reads = 0;
  private titles: Map<string, string> = new Map();
  failing = false;

  setTitle(threadId: string, title: string): void {
    this.titles.set(threadId, title);
  }

  readCurrentTitle(threadId: string): TitleReadResult {
    this.reads += 1;
    if (this.failing) return { ok: false };
    const title = this.titles.get(threadId);
    return title === undefined ? { ok: false } : { ok: true, title };
  }
}

function stop(
  sessionId: string,
  turnId: string,
  options: { transcriptPath?: string | null; stopHookActive?: boolean } = {},
): Record<string, unknown> {
  return {
    hook_event_name: "Stop",
    session_id: sessionId,
    turn_id: turnId,
    transcript_path: options.transcriptPath ?? "/tmp/rollout.jsonl",
    ...(options.stopHookActive === undefined
      ? {}
      : { stop_hook_active: options.stopHookActive }),
    last_assistant_message: "未知追加field",
  };
}

function promptSubmit(
  sessionId: string,
  turnId = "prompt-turn",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    turn_id: turnId,
    prompt: "次の依頼",
    ...extra,
  };
}

function additionalContextOf(output: HookOutput): string {
  if (!("hookSpecificOutput" in output)) return "";
  return output.hookSpecificOutput.additionalContext;
}

function harness(options: {
  every?: number;
  maxChars?: number;
  store?: HookStateStore;
  logger?: (code: HookLogCode) => void;
  clock?: () => string;
} = {}) {
  const store = options.store ?? openStore();
  const reader = new FakeTitleReader();
  const logs: HookLogCode[] = [];
  const controller = new HookController({
    store,
    titleReader: reader,
    every: options.every ?? 3,
    maxChars: options.maxChars ?? 40,
    clock: options.clock ?? (() => NOW),
    logger: options.logger ?? ((code) => {
      logs.push(code);
    }),
  });
  return { controller, store, reader, logs };
}

async function runTurns(
  h: ReturnType<typeof harness>,
  sessionId: string,
  count: number,
  startAt = 1,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await h.controller.handle(stop(sessionId, `turn-${startAt + index}`));
  }
}

describe("Stop hookの更新予約", () => {
  test("every回目の新しいStopでpendingを立てるだけで出力しない", async () => {
    const h = harness();
    h.reader.setTitle("s1", "既定タイトル");

    await runTurns(h, "s1", 2);
    expect((h.store as StateStore).getSession("s1")?.pendingUpdate).toBe(false);

    expect(await h.controller.handle(stop("s1", "turn-3"))).toEqual({});
    expect((h.store as StateStore).getSession("s1")?.pendingUpdate).toBe(true);
    expect(h.reader.reads).toBe(0);
  });

  test("同じturn_idの再送とstop_hook_activeは数えない", async () => {
    const h = harness();

    await h.controller.handle(stop("s1", "turn-1"));
    await h.controller.handle(stop("s1", "turn-1"));
    await h.controller.handle(stop("s1", "turn-2", { stopHookActive: true }));

    expect((h.store as StateStore).getSession("s1")?.stopCount).toBe(1);
  });

  test("自動更新停止済みセッションはpendingを立てない", async () => {
    const h = harness();
    const store = h.store as StateStore;
    store.recordStop("s1", "seed", NOW);
    store.markAutoUpdateDisabled("s1", NOW);

    await runTurns(h, "s1", 5, 2);

    expect(store.getSession("s1")?.pendingUpdate).toBe(false);
  });
});

describe("UserPromptSubmitの指示注入", () => {
  test("pending時に現在タイトルを基準保存してリネーム指示を注入する", async () => {
    const h = harness({ maxChars: 25 });
    const store = h.store as StateStore;
    h.reader.setTitle("s1", "既定タイトル");
    await runTurns(h, "s1", 3);

    const output = await h.controller.handle(promptSubmit("s1", "turn-4"));

    const context = additionalContextOf(output);
    expect(context).toContain(SET_THREAD_TITLE_TOOL_NAME);
    expect(context).toContain('threadId="s1"');
    expect(context).toContain("最大25文字");
    expect(context).not.toContain("read_thread");
    expect(context).not.toContain("許可");
    expect(store.getPendingWrite("s1")).toEqual(
      expect.objectContaining({ turnId: "turn-4", baselineTitle: "既定タイトル" }),
    );
  });

  test("pendingがないセッションではタイトルを読まず何もしない", async () => {
    const h = harness();
    h.reader.setTitle("s1", "既定タイトル");
    await runTurns(h, "s1", 1);

    expect(await h.controller.handle(promptSubmit("s1"))).toEqual({});
    expect(h.reader.reads).toBe(0);
  });

  test("同じturnの重複UserPromptSubmitでは再注入しない", async () => {
    const h = harness();
    h.reader.setTitle("s1", "既定タイトル");
    await runTurns(h, "s1", 3);

    expect(additionalContextOf(await h.controller.handle(promptSubmit("s1", "turn-4")))).not.toBe("");
    expect(await h.controller.handle(promptSubmit("s1", "turn-4"))).toEqual({});
  });

  test("アプリDBを読めない場合は注入せずpendingを保持して後で再試行する", async () => {
    const h = harness();
    const store = h.store as StateStore;
    h.reader.failing = true;
    await runTurns(h, "s1", 3);

    expect(await h.controller.handle(promptSubmit("s1", "turn-4"))).toEqual({});
    expect(h.logs).toContain("app_db_read_failed");
    expect(store.getSession("s1")?.pendingUpdate).toBe(true);
    expect(store.getSession("s1")?.autoUpdateDisabled).toBe(false);
    expect(store.getPendingWrite("s1")).toBeUndefined();

    h.reader.failing = false;
    h.reader.setTitle("s1", "既定タイトル");
    expect(additionalContextOf(await h.controller.handle(promptSubmit("s1", "turn-5")))).not.toBe("");
  });
});

describe("書込み検証とタイトル採用", () => {
  test("注入後のStopでタイトル変化を検出して自動タイトルとして採用する", async () => {
    const h = harness();
    const store = h.store as StateStore;
    h.reader.setTitle("s1", "既定タイトル");
    await runTurns(h, "s1", 3);
    await h.controller.handle(promptSubmit("s1", "turn-4"));

    h.reader.setTitle("s1", "自動タイトルA");
    await h.controller.handle(stop("s1", "turn-4"));

    const state = store.getSession("s1");
    expect(state?.lastAutoTitle).toBe("自動タイトルA");
    expect(state?.pendingUpdate).toBe(false);
    expect(state?.lastSuccessAt).toBe(NOW);
    expect(store.getPendingWrite("s1")).toBeUndefined();
  });

  test("リネームが遅延反映でも次のUserPromptSubmitで採用して注入しない", async () => {
    const h = harness();
    const store = h.store as StateStore;
    h.reader.setTitle("s1", "既定タイトル");
    await runTurns(h, "s1", 3);
    await h.controller.handle(promptSubmit("s1", "turn-4"));

    // The rename has not landed yet when the turn's Stop fires.
    await h.controller.handle(stop("s1", "turn-4"));
    expect(store.getPendingWrite("s1")).toEqual(
      expect.objectContaining({ baselineTitle: "既定タイトル" }),
    );

    h.reader.setTitle("s1", "自動タイトルA");
    expect(await h.controller.handle(promptSubmit("s1", "turn-5"))).toEqual({});
    expect(store.getSession("s1")?.lastAutoTitle).toBe("自動タイトルA");
    expect(store.getSession("s1")?.pendingUpdate).toBe(false);
  });

  test("モデルがリネームしなかった場合は次のUserPromptSubmitで再注入する", async () => {
    const h = harness();
    const store = h.store as StateStore;
    h.reader.setTitle("s1", "既定タイトル");
    await runTurns(h, "s1", 3);
    await h.controller.handle(promptSubmit("s1", "turn-4"));
    await h.controller.handle(stop("s1", "turn-4"));

    const output = await h.controller.handle(promptSubmit("s1", "turn-5"));

    expect(additionalContextOf(output)).toContain(SET_THREAD_TITLE_TOOL_NAME);
    expect(store.getPendingWrite("s1")).toEqual(
      expect.objectContaining({ turnId: "turn-5", baselineTitle: "既定タイトル" }),
    );
  });

  test("検証時にアプリDBを読めない場合は採用も破棄もしない", async () => {
    const h = harness();
    const store = h.store as StateStore;
    h.reader.setTitle("s1", "既定タイトル");
    await runTurns(h, "s1", 3);
    await h.controller.handle(promptSubmit("s1", "turn-4"));

    h.reader.failing = true;
    await h.controller.handle(stop("s1", "turn-4"));

    expect(h.logs).toContain("app_db_read_failed");
    expect(store.getPendingWrite("s1")).toEqual(
      expect.objectContaining({ baselineTitle: "既定タイトル" }),
    );
    expect(store.getSession("s1")?.lastAutoTitle).toBeNull();
  });
});

describe("手動リネーム保護", () => {
  test("自動タイトルから手動変更されたら自動更新を停止して注入しない", async () => {
    const h = harness();
    const store = h.store as StateStore;
    h.reader.setTitle("s1", "既定タイトル");
    await runTurns(h, "s1", 3);
    await h.controller.handle(promptSubmit("s1", "turn-4"));
    h.reader.setTitle("s1", "自動タイトルA");
    await h.controller.handle(stop("s1", "turn-4"));

    // The user renames the task by hand afterwards.
    h.reader.setTitle("s1", "俺のタイトル");
    await runTurns(h, "s1", 2, 5);
    expect(store.getSession("s1")?.pendingUpdate).toBe(true);

    expect(await h.controller.handle(promptSubmit("s1", "turn-7"))).toEqual({});
    const state = store.getSession("s1");
    expect(state?.autoUpdateDisabled).toBe(true);
    expect(state?.pendingUpdate).toBe(false);

    // Later cycles never inject again.
    await runTurns(h, "s1", 3, 7);
    expect(await h.controller.handle(promptSubmit("s1", "turn-10"))).toEqual({});
    expect(store.getSession("s1")?.pendingUpdate).toBe(false);
  });

  test("初回更新前(lastAutoTitleなし)は既定タイトルからでも注入する", async () => {
    const h = harness();
    h.reader.setTitle("s1", "最初のユーザーメッセージ由来のタイトル");
    await runTurns(h, "s1", 3);

    expect(additionalContextOf(await h.controller.handle(promptSubmit("s1", "turn-4")))).toContain(
      SET_THREAD_TITLE_TOOL_NAME,
    );
  });

  test("自動タイトルのまま変化がなければ次サイクルも注入する", async () => {
    const h = harness();
    h.reader.setTitle("s1", "既定タイトル");
    await runTurns(h, "s1", 3);
    await h.controller.handle(promptSubmit("s1", "turn-4"));
    h.reader.setTitle("s1", "自動タイトルA");
    await h.controller.handle(stop("s1", "turn-4"));

    await runTurns(h, "s1", 2, 5);
    const output = await h.controller.handle(promptSubmit("s1", "turn-7"));

    expect(additionalContextOf(output)).toContain(SET_THREAD_TITLE_TOOL_NAME);
  });
});

describe("入力検証と安全動作", () => {
  test("不正なStop入力は数えずログだけ残す", async () => {
    const h = harness();

    expect(await h.controller.handle(stop("s1", "turn-1", { transcriptPath: "relative/path" }))).toEqual({});
    expect(await h.controller.handle({ hook_event_name: "Stop", session_id: "s1" })).toEqual({});
    expect(h.logs).toEqual(["invalid_stop_input", "invalid_stop_input"]);
    expect((h.store as StateStore).getSession("s1")).toBeUndefined();
  });

  test("不正なUserPromptSubmit入力はログだけ残す", async () => {
    const h = harness();

    expect(await h.controller.handle({ hook_event_name: "UserPromptSubmit" })).toEqual({});
    expect(h.logs).toEqual(["invalid_prompt_input"]);
  });

  test("未知イベントと子プロセス環境では何もしない", async () => {
    const h = harness();

    expect(await h.controller.handle({ hook_event_name: "SessionStart" })).toEqual({});
    expect(await h.controller.handle("not-an-object")).toEqual({});
    expect(
      await h.controller.handle(promptSubmit("s1"), { CODEX_TITLE_CHILD: "1" }),
    ).toEqual({});
    expect(h.logs).toEqual([]);
  });

  test("state store失敗時は出力契約{}を守る", async () => {
    const failingStore: HookStateStore = {
      getSession() {
        throw new Error("boom");
      },
      recordStop() {
        throw new Error("boom");
      },
      markPending() {
        throw new Error("boom");
      },
      markAutoUpdateDisabled() {
        throw new Error("boom");
      },
      getPendingWrite() {
        throw new Error("boom");
      },
      beginPendingWrite() {
        throw new Error("boom");
      },
      clearPendingWrite() {
        throw new Error("boom");
      },
      adoptAutoTitle() {
        throw new Error("boom");
      },
    };
    const h = harness({ store: failingStore });

    expect(await h.controller.handle(stop("s1", "turn-1"))).toEqual({});
    expect(await h.controller.handle(promptSubmit("s1"))).toEqual({});
    expect(h.logs).toEqual(["state_store_failed", "state_store_failed"]);
  });

  test("loggerの例外はhook出力へ波及しない", async () => {
    const h = harness({
      logger() {
        throw new Error("logger-broken");
      },
    });

    expect(await h.controller.handle({ hook_event_name: "Stop" })).toEqual({});
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import {
  HookController,
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
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    prompt: "次の依頼",
    ...extra,
  };
}

function additionalContextOf(output: HookOutput): string {
  return "hookSpecificOutput" in output ? output.hookSpecificOutput.additionalContext : "";
}

function harness(options: {
  every?: number;
  maxChars?: number;
  store?: HookStateStore;
  logger?: (code: HookLogCode) => void;
  clock?: () => string;
} = {}) {
  const store = options.store ?? openStore();
  const logs: HookLogCode[] = [];
  const controller = new HookController({
    store,
    every: options.every ?? 3,
    maxChars: options.maxChars ?? 40,
    clock: options.clock ?? (() => NOW),
    logger: options.logger ?? ((code) => logs.push(code)),
  });
  return { controller, store, logs };
}

function throwingStore(operation: keyof HookStateStore): HookStateStore {
  const base = openStore();
  return {
    getSession: (sessionId) => base.getSession(sessionId),
    recordStop: (sessionId, turnId, now) => base.recordStop(sessionId, turnId, now),
    markPending: (sessionId, now) => base.markPending(sessionId, now),
    markRenameContinuationFinished: (sessionId, now) =>
      base.markRenameContinuationFinished(sessionId, now),
    [operation](): never {
      throw new Error("database-secret");
    },
  } as HookStateStore;
}

describe("HookController", () => {
  test("CODEX_TITLE_CHILD=1ならinputに一切触れず即終了する", async () => {
    const input = new Proxy({}, { get() { throw new Error("must not inspect"); } });
    const h = harness({ store: throwingStore("recordStop") });

    await expect(h.controller.handle(input, { CODEX_TITLE_CHILD: "1" })).resolves.toEqual({});
    expect(h.logs).toEqual([]);
  });

  test.each([
    ["別event", { hook_event_name: "SessionStart", session_id: null }],
    ["event欠落", { session_id: "s1" }],
    ["非object", null],
  ])("対象外イベント（%s）は他fieldを検証せず何もしない", async (_name, input) => {
    const h = harness({ store: throwingStore("recordStop") });

    await expect(h.controller.handle(input)).resolves.toEqual({});
    expect(h.logs).toEqual([]);
  });

  test.each([
    ["session欠落", { hook_event_name: "Stop", turn_id: "t1", transcript_path: null }],
    ["turn欠落", { hook_event_name: "Stop", session_id: "s1", transcript_path: null }],
    ["transcript欠落", { hook_event_name: "Stop", session_id: "s1", turn_id: "t1" }],
    ["session型", { hook_event_name: "Stop", session_id: 1, turn_id: "t1", transcript_path: null }],
    ["turn型", { hook_event_name: "Stop", session_id: "s1", turn_id: null, transcript_path: null }],
    ["transcript型", { hook_event_name: "Stop", session_id: "s1", turn_id: "t1", transcript_path: 42 }],
    ["stop_hook_active型", { ...stop("s1", "t1"), stop_hook_active: "yes" }],
    ["空session", stop("", "t1")],
    ["空turn", stop("s1", "")],
    ["NUL session", stop("s\0secret", "t1")],
    ["NUL turn", stop("s1", "t\0secret")],
    ["長いsession", stop("s".repeat(4097), "t1")],
    ["長いturn", stop("s1", "t".repeat(4097))],
    ["相対path", stop("s1", "t1", { transcriptPath: "secret.jsonl" })],
    ["空path", stop("s1", "t1", { transcriptPath: "" })],
    ["NUL path", stop("s1", "t1", { transcriptPath: "/tmp/secret\0.jsonl" })],
    ["長いpath", stop("s1", "t1", { transcriptPath: `/${"p".repeat(4096)}` })],
  ])("不正なStop（%s）は記録せず固定codeだけをログする", async (_name, input) => {
    const h = harness({ store: throwingStore("recordStop") });

    await expect(h.controller.handle(input)).resolves.toEqual({});
    expect(h.logs).toEqual(["invalid_stop_input"]);
  });

  test.each([
    ["session欠落", { hook_event_name: "UserPromptSubmit", prompt: "p" }],
    ["session型", promptSubmit("ignored", { session_id: 1 })],
    ["null session", promptSubmit("ignored", { session_id: null })],
    ["空session", promptSubmit("ignored", { session_id: "" })],
    ["NUL session", promptSubmit("ignored", { session_id: "s\0secret" })],
    ["長いsession", promptSubmit("ignored", { session_id: "s".repeat(4097) })],
  ])("不正なUserPromptSubmit（%s）は注入せず固定codeだけをログする", async (_name, input) => {
    const h = harness({ store: throwingStore("getSession") });

    await expect(h.controller.handle(input)).resolves.toEqual({});
    expect(h.logs).toEqual(["invalid_prompt_input"]);
  });

  test("更新回のStopはpendingだけ保存し出力は常に{}", async () => {
    const h = harness({ every: 3 });

    expect(await h.controller.handle(stop("s1", "t1"))).toEqual({});
    expect(await h.controller.handle(stop("s1", "t2"))).toEqual({});
    expect(await h.controller.handle(stop("s1", "t3"))).toEqual({});

    expect((h.store as StateStore).getSession("s1")).toEqual(
      expect.objectContaining({ stopCount: 3, pendingUpdate: true }),
    );
  });

  test("pendingがあれば次のUserPromptSubmitでrename指示を注入しpendingを完了する", async () => {
    const h = harness({ every: 1, maxChars: 32 });
    await h.controller.handle(stop("s1", "t1"));

    const output = await h.controller.handle(promptSubmit("s1"));

    expect(output).toMatchObject({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit" },
    });
    expect(additionalContextOf(output)).toContain("codex_app__set_thread_title");
    expect(additionalContextOf(output)).toContain("32文字");
    expect((h.store as StateStore).getSession("s1")).toEqual(
      expect.objectContaining({ pendingUpdate: false, lastSuccessAt: NOW }),
    );
  });

  test("注入は1回だけで連続プロンプトでは繰り返さない", async () => {
    const h = harness({ every: 1 });
    await h.controller.handle(stop("s1", "t1"));

    expect(additionalContextOf(await h.controller.handle(promptSubmit("s1")))).not.toBe("");
    expect(await h.controller.handle(promptSubmit("s1"))).toEqual({});
  });

  test("pendingがなければUserPromptSubmitは何も注入しない", async () => {
    const h = harness({ every: 3 });
    await h.controller.handle(stop("s1", "t1"));

    expect(await h.controller.handle(promptSubmit("s1"))).toEqual({});
    expect(await h.controller.handle(promptSubmit("unknown-session"))).toEqual({});
    expect(h.logs).toEqual([]);
  });

  test("null transcriptも公式Stop入力として受理する", async () => {
    const h = harness({ every: 1 });
    const input = stop("s1", "t1", { transcriptPath: null });
    const original = structuredClone(input);

    expect(await h.controller.handle(input)).toEqual({});
    expect(input).toEqual(original);
    expect((h.store as StateStore).getSession("s1")?.pendingUpdate).toBe(true);
  });

  test("同一turnの再送は数えずpending判定もしない", async () => {
    const h = harness({ every: 2 });

    await h.controller.handle(stop("s1", "t1"));
    await h.controller.handle(stop("s1", "t1"));

    expect((h.store as StateStore).getSession("s1")).toEqual(
      expect.objectContaining({ stopCount: 1, pendingUpdate: false }),
    );
  });

  test("stop_hook_active: trueの継続側Stopは回数に含めない", async () => {
    const h = harness({ every: 1 });
    await h.controller.handle(stop("s1", "t1"));

    expect(await h.controller.handle(stop("s1", "t2", { stopHookActive: true }))).toEqual({});
    expect((h.store as StateStore).getSession("s1")?.stopCount).toBe(1);
  });

  test("注入前にStopが続いてもpendingを維持し後から注入できる", async () => {
    const h = harness({ every: 3 });
    await h.controller.handle(stop("s1", "t1"));
    await h.controller.handle(stop("s1", "t2"));
    await h.controller.handle(stop("s1", "t3"));
    await h.controller.handle(stop("s1", "t4"));

    expect((h.store as StateStore).getSession("s1")?.pendingUpdate).toBe(true);
    expect(additionalContextOf(await h.controller.handle(promptSubmit("s1")))).toContain(
      "codex_app__set_thread_title",
    );
  });

  test("停止済みsessionはStop数だけ記録し注入もしない", async () => {
    const store = openStore();
    store.markAutoUpdateDisabled("s1", "disabled");
    const h = harness({ every: 1, store });

    expect(await h.controller.handle(stop("s1", "t1"))).toEqual({});
    expect(store.getSession("s1")?.stopCount).toBe(1);
    expect(await h.controller.handle(promptSubmit("s1"))).toEqual({});
  });

  test("別sessionの状態を分離する", async () => {
    const h = harness({ every: 2 });

    await h.controller.handle(stop("s1", "t1"));
    await h.controller.handle(stop("s2", "t1"));
    await h.controller.handle(stop("s1", "t2"));
    await h.controller.handle(stop("s2", "t2"));

    expect(additionalContextOf(await h.controller.handle(promptSubmit("s1")))).not.toBe("");
    expect(additionalContextOf(await h.controller.handle(promptSubmit("s2")))).not.toBe("");
    expect((h.store as StateStore).getSession("s1")?.pendingUpdate).toBe(false);
    expect((h.store as StateStore).getSession("s2")?.pendingUpdate).toBe(false);
  });

  test.each(["recordStop", "markPending"] as const)(
    "Stop側の%s失敗を固定ログへ変換する",
    async (operation) => {
      const h = harness({ every: 1, store: throwingStore(operation) });

      await expect(h.controller.handle(stop("s1", "t1"))).resolves.toEqual({});
      expect(h.logs).toEqual(["state_store_failed"]);
    },
  );

  test("UserPromptSubmit側のgetSession失敗を固定ログへ変換する", async () => {
    const h = harness({ store: throwingStore("getSession") });

    await expect(h.controller.handle(promptSubmit("s1"))).resolves.toEqual({});
    expect(h.logs).toEqual(["state_store_failed"]);
  });

  test("完了の記録に失敗したら注入せず固定ログへ変換する", async () => {
    const base = openStore();
    base.markPending("s1", NOW);
    const store: HookStateStore = {
      getSession: (sessionId) => base.getSession(sessionId),
      recordStop: (sessionId, turnId, now) => base.recordStop(sessionId, turnId, now),
      markPending: (sessionId, now) => base.markPending(sessionId, now),
      markRenameContinuationFinished() {
        throw new Error("database-secret");
      },
    };
    const h = harness({ store });

    await expect(h.controller.handle(promptSubmit("s1"))).resolves.toEqual({});
    expect(h.logs).toEqual(["state_store_failed"]);
    expect(base.getSession("s1")?.pendingUpdate).toBe(true);
  });

  test("logger自体がthrowしてもHook処理を妨げない", async () => {
    const h = harness({
      every: 1,
      store: throwingStore("recordStop"),
      logger() {
        throw new Error("logger-secret");
      },
    });

    await expect(h.controller.handle(stop("s1", "t1"))).resolves.toEqual({});
  });
});

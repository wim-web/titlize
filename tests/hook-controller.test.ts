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
    turn_id: "prompt-turn",
    prompt: "次の依頼",
    ...extra,
  };
}

function preSetTitle(
  sessionId: string,
  turnId: string,
  title: string,
  threadId = sessionId,
): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    turn_id: turnId,
    tool_name: "codex_app__set_thread_title",
    tool_input: { threadId, title },
  };
}

function postReadTitle(
  sessionId: string,
  turnId: string,
  title: string | null,
  threadId = sessionId,
): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    turn_id: turnId,
    tool_name: "codex_app__read_thread",
    tool_input: { threadId },
    tool_response: { thread: { id: threadId, title } },
  };
}

function postSetTitle(
  sessionId: string,
  turnId: string,
  title: string,
  threadId = sessionId,
): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    session_id: sessionId,
    turn_id: turnId,
    tool_name: "codex_app__set_thread_title",
    tool_input: { threadId, title },
    tool_response: { threadId, title },
  };
}

function additionalContextOf(output: HookOutput): string {
  if (!("hookSpecificOutput" in output)) return "";
  return "additionalContext" in output.hookSpecificOutput
    ? output.hookSpecificOutput.additionalContext
    : "";
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
  return new Proxy(base as unknown as HookStateStore, {
    get(target, property, receiver) {
      if (property === operation) return () => { throw new Error("database-secret"); };
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(base) : value;
    },
  });
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
    ["turn欠落", { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "p" }],
    ["session型", promptSubmit("ignored", { session_id: 1 })],
    ["turn型", promptSubmit("ignored", { turn_id: 1 })],
    ["null session", promptSubmit("ignored", { session_id: null })],
    ["空session", promptSubmit("ignored", { session_id: "" })],
    ["空turn", promptSubmit("ignored", { turn_id: "" })],
    ["NUL session", promptSubmit("ignored", { session_id: "s\0secret" })],
    ["NUL turn", promptSubmit("ignored", { turn_id: "t\0secret" })],
    ["長いsession", promptSubmit("ignored", { session_id: "s".repeat(4097) })],
    ["長いturn", promptSubmit("ignored", { turn_id: "t".repeat(4097) })],
  ])("不正なUserPromptSubmit（%s）は注入せず固定codeだけをログする", async (_name, input) => {
    const h = harness({ store: throwingStore("beginRenameAttempt") });

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

  test("pendingがあれば次のUserPromptSubmitでread→rename指示を注入しturnを相関する", async () => {
    const h = harness({ every: 1, maxChars: 32 });
    await h.controller.handle(stop("s1", "t1"));

    const output = await h.controller.handle(promptSubmit("s1"));

    expect(output).toMatchObject({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit" },
    });
    expect(additionalContextOf(output)).toContain("codex_app__set_thread_title");
    expect(additionalContextOf(output)).toContain("codex_app__read_thread");
    expect(additionalContextOf(output)).toContain('threadId="s1"');
    expect(additionalContextOf(output)).toContain("turnLimit=1");
    expect(additionalContextOf(output)).toContain("32文字");
    expect((h.store as StateStore).getSession("s1")).toEqual(
      expect.objectContaining({ pendingUpdate: true, lastSuccessAt: null }),
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

  test("read_thread確認後だけset_thread_titleを許可し成功タイトルを所有状態へ保存する", async () => {
    const h = harness({ every: 1 });
    await h.controller.handle(stop("s1", "stop-1"));
    await h.controller.handle(promptSubmit("s1", { turn_id: "rename-1" }));

    const readOutput = await h.controller.handle(postReadTitle("s1", "rename-1", "初期タイトル"));
    expect(additionalContextOf(readOutput)).toContain("書込みを許可");
    expect(await h.controller.handle(preSetTitle("s1", "rename-1", "自動タイトル"))).toEqual({});
    expect((h.store as StateStore).getSession("s1")).toEqual(expect.objectContaining({
      pendingTitle: "自動タイトル",
      pendingPreviousTitle: "初期タイトル",
      pendingPreviousTitleKnown: true,
    }));

    expect(await h.controller.handle(postSetTitle("s1", "rename-1", "自動タイトル"))).toEqual({});
    expect((h.store as StateStore).getSession("s1")).toEqual(expect.objectContaining({
      pendingUpdate: false,
      pendingTitle: null,
      lastAutoTitle: "自動タイトル",
      lastSuccessAt: NOW,
    }));
  });

  test("前回自動タイトルから変わっていれば手動変更としてsetを機械的に拒否する", async () => {
    const store = openStore();
    store.markSuccess("s1", "前回の自動タイトル", "success");
    store.markPending("s1", "pending");
    const h = harness({ store });
    await h.controller.handle(promptSubmit("s1", { turn_id: "rename-2" }));

    const readOutput = await h.controller.handle(postReadTitle("s1", "rename-2", "手動タイトル"));
    expect(additionalContextOf(readOutput)).toContain("手動タイトル変更を検出");
    expect(store.getSession("s1")).toEqual(expect.objectContaining({
      autoUpdateDisabled: true,
      pendingUpdate: false,
      lastAutoTitle: "前回の自動タイトル",
    }));
    expect(await h.controller.handle(preSetTitle("s1", "rename-2", "上書き候補"))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
  });

  test("read_threadより先の自動setと同一turnの二重setを拒否する", async () => {
    const h = harness({ every: 1 });
    await h.controller.handle(stop("s1", "stop-1"));
    await h.controller.handle(promptSubmit("s1", { turn_id: "rename-3" }));

    expect(await h.controller.handle(preSetTitle("s1", "rename-3", "早すぎる"))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await h.controller.handle(postReadTitle("s1", "rename-3", "初期タイトル"));
    expect(await h.controller.handle(preSetTitle("s1", "rename-3", "候補"))).toEqual({});
    expect(await h.controller.handle(preSetTitle("s1", "rename-3", "二重候補"))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  test("titlize attempt外の通常setと別task向けtoolは妨げない", async () => {
    const h = harness({ every: 1 });

    expect(await h.controller.handle(preSetTitle("s1", "normal-turn", "通常変更"))).toEqual({});
    await h.controller.handle(stop("s1", "stop-1"));
    await h.controller.handle(promptSubmit("s1", { turn_id: "rename-4" }));
    expect(await h.controller.handle(preSetTitle("s1", "rename-4", "別task", "s2"))).toEqual({});
    expect(await h.controller.handle(postReadTitle("s1", "rename-4", "別task", "s2"))).toEqual({});
  });

  test("read_thread結果を解釈できなければsetを許可せず固定codeだけをログする", async () => {
    const h = harness({ every: 1 });
    await h.controller.handle(stop("s1", "stop-1"));
    await h.controller.handle(promptSubmit("s1", { turn_id: "rename-5" }));
    const input = postReadTitle("s1", "rename-5", "unused");
    input.tool_response = { content: [{ type: "text", text: "not-json" }] };

    expect(additionalContextOf(await h.controller.handle(input))).toContain("確認できなかった");
    expect(h.logs).toEqual(["title_read_failed"]);
    expect(await h.controller.handle(preSetTitle("s1", "rename-5", "候補"))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  test("CallToolResultのtext内JSONからread/set結果を安全に復元する", async () => {
    const h = harness({ every: 1 });
    await h.controller.handle(stop("s1", "stop-1"));
    await h.controller.handle(promptSubmit("s1", { turn_id: "rename-6" }));
    const read = postReadTitle("s1", "rename-6", "unused");
    read.tool_response = {
      content: [{ type: "text", text: JSON.stringify({ thread: { id: "s1", name: "初期" } }) }],
    };
    expect(additionalContextOf(await h.controller.handle(read))).toContain("書込みを許可");
    await h.controller.handle(preSetTitle("s1", "rename-6", "候補"));
    const set = postSetTitle("s1", "rename-6", "候補");
    set.tool_response = {
      content: [{ type: "text", text: JSON.stringify({ threadId: "s1", title: "候補" }) }],
    };
    expect(await h.controller.handle(set)).toEqual({});
    expect((h.store as StateStore).getSession("s1")?.lastAutoTitle).toBe("候補");
  });

  test("別sessionの状態を分離する", async () => {
    const h = harness({ every: 2 });

    await h.controller.handle(stop("s1", "t1"));
    await h.controller.handle(stop("s2", "t1"));
    await h.controller.handle(stop("s1", "t2"));
    await h.controller.handle(stop("s2", "t2"));

    expect(additionalContextOf(await h.controller.handle(promptSubmit("s1")))).not.toBe("");
    expect(additionalContextOf(await h.controller.handle(promptSubmit("s2")))).not.toBe("");
    expect((h.store as StateStore).getSession("s1")?.pendingUpdate).toBe(true);
    expect((h.store as StateStore).getSession("s2")?.pendingUpdate).toBe(true);
  });

  test.each(["recordStop", "markPending"] as const)(
    "Stop側の%s失敗を固定ログへ変換する",
    async (operation) => {
      const h = harness({ every: 1, store: throwingStore(operation) });

      await expect(h.controller.handle(stop("s1", "t1"))).resolves.toEqual({});
      expect(h.logs).toEqual(["state_store_failed"]);
    },
  );

  test("UserPromptSubmit側のbeginRenameAttempt失敗を固定ログへ変換する", async () => {
    const h = harness({ store: throwingStore("beginRenameAttempt") });

    await expect(h.controller.handle(promptSubmit("s1"))).resolves.toEqual({});
    expect(h.logs).toEqual(["state_store_failed"]);
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

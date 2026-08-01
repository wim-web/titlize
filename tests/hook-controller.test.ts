import { afterEach, describe, expect, test } from "bun:test";
import { HookController, type HookLogCode, type HookTitleUpdateService } from "../src/hook-controller";
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
  transcriptPath: string | null = "/tmp/rollout.jsonl",
): Record<string, unknown> {
  return {
    hook_event_name: "Stop",
    session_id: sessionId,
    turn_id: turnId,
    transcript_path: transcriptPath,
    last_assistant_message: "未知追加field",
  };
}

function harness(options: {
  every?: number;
  store?: Pick<StateStore, "recordStop">;
  update?: HookTitleUpdateService["update"];
  logger?: (code: HookLogCode) => void;
  clock?: () => string;
} = {}) {
  const store = options.store ?? openStore();
  const updates: unknown[] = [];
  const logs: HookLogCode[] = [];
  const service: HookTitleUpdateService = {
    async update(input) {
      updates.push(structuredClone(input));
      return options.update ? options.update(input) : { status: "updated" };
    },
  };
  const controller = new HookController({
    store,
    service,
    every: options.every ?? 3,
    clock: options.clock ?? (() => NOW),
    logger: options.logger ?? ((code) => logs.push(code)),
  });
  return { controller, store, updates, logs };
}

describe("HookController", () => {
  test("CODEX_TITLE_CHILD=1ならinputに一切触れず即終了する", async () => {
    const h = harness({
      store: {
        recordStop() {
          throw new Error("must not call");
        },
      },
    });
    const input = new Proxy({}, { get() { throw new Error("must not inspect"); } });

    await expect(h.controller.handle(input, { CODEX_TITLE_CHILD: "1" })).resolves.toBeUndefined();
    expect(h.updates).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  test.each([
    ["別event", { hook_event_name: "UserPromptSubmit", session_id: null }],
    ["event欠落", { session_id: "s1" }],
    ["非object", null],
  ])("Stop以外（%s）は他fieldを検証せず何もしない", async (_name, input) => {
    const h = harness({
      store: { recordStop() { throw new Error("must not call"); } },
    });

    await expect(h.controller.handle(input)).resolves.toBeUndefined();
    expect(h.updates).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  test.each([
    ["session欠落", { hook_event_name: "Stop", turn_id: "t1", transcript_path: null }],
    ["turn欠落", { hook_event_name: "Stop", session_id: "s1", transcript_path: null }],
    ["transcript欠落", { hook_event_name: "Stop", session_id: "s1", turn_id: "t1" }],
    ["session型", { hook_event_name: "Stop", session_id: 1, turn_id: "t1", transcript_path: null }],
    ["turn型", { hook_event_name: "Stop", session_id: "s1", turn_id: null, transcript_path: null }],
    ["transcript型", { hook_event_name: "Stop", session_id: "s1", turn_id: "t1", transcript_path: 42 }],
    ["空session", stop("", "t1")],
    ["空turn", stop("s1", "")],
    ["NUL session", stop("s\0secret", "t1")],
    ["NUL turn", stop("s1", "t\0secret")],
    ["長いsession", stop("s".repeat(4097), "t1")],
    ["長いturn", stop("s1", "t".repeat(4097))],
    ["相対path", stop("s1", "t1", "secret.jsonl")],
    ["空path", stop("s1", "t1", "")],
    ["NUL path", stop("s1", "t1", "/tmp/secret\0.jsonl")],
    ["長いpath", stop("s1", "t1", `/${"p".repeat(4096)}`)],
  ])("不正なStop（%s）は記録せず固定codeだけをログする", async (_name, input) => {
    let records = 0;
    const h = harness({ store: { recordStop() { records += 1; throw new Error("secret"); } } });

    await expect(h.controller.handle(input)).resolves.toBeUndefined();
    expect(records).toBe(0);
    expect(h.updates).toEqual([]);
    expect(h.logs).toEqual(["invalid_stop_input"]);
  });

  test("必須fieldをProxyの継承風getterから補完しない", async () => {
    let records = 0;
    const h = harness({ store: { recordStop() { records += 1; throw new Error("secret"); } } });
    const input = new Proxy(
      { hook_event_name: "Stop", turn_id: "t1", transcript_path: null },
      {
        get(target, key, receiver) {
          if (key === "session_id") return "s1";
          return Reflect.get(target, key, receiver);
        },
      },
    );

    await h.controller.handle(input);

    expect(records).toBe(0);
    expect(h.logs).toEqual(["invalid_stop_input"]);
  });

  test("null transcriptは公式入力として記録し周期時にundefinedをserviceへ渡す", async () => {
    const h = harness({ every: 1 });
    const input = stop("s1", "t1", null);
    const original = structuredClone(input);

    await expect(h.controller.handle(input)).resolves.toBeUndefined();

    expect(h.updates).toEqual([{ sessionId: "s1", transcriptPath: undefined, force: false }]);
    expect(input).toEqual(original);
  });

  test("同一turnと非連続duplicateは数えず更新もしない", async () => {
    const h = harness({ every: 1 });

    await h.controller.handle(stop("s1", "t1"));
    await h.controller.handle(stop("s1", "t2"));
    await h.controller.handle(stop("s1", "t1"));

    expect(h.updates).toHaveLength(2);
    expect((h.store as StateStore).getSession("s1")?.stopCount).toBe(2);
  });

  test("3回周期では2回目をskip、3回目だけ更新、4回目をskipする", async () => {
    const h = harness({ every: 3 });

    await h.controller.handle(stop("s1", "t1"));
    await h.controller.handle(stop("s1", "t2"));
    expect(h.updates).toEqual([]);
    await h.controller.handle(stop("s1", "t3"));
    expect(h.updates).toEqual([{ sessionId: "s1", transcriptPath: "/tmp/rollout.jsonl", force: false }]);
    await h.controller.handle(stop("s1", "t4"));
    expect(h.updates).toHaveLength(1);
  });

  test("N回目の失敗がpendingを残すと次のdistinct Stopで周期外再試行する", async () => {
    const store = openStore();
    let attempt = 0;
    const h = harness({
      every: 3,
      store,
      async update(input) {
        attempt += 1;
        if (attempt === 1) {
          store.markPending(input.sessionId, "pending");
          throw new Error("provider-secret");
        }
        store.markSuccess(input.sessionId, "成功タイトル", "success");
        return { status: "updated" };
      },
    });

    await h.controller.handle(stop("s1", "t1"));
    await h.controller.handle(stop("s1", "t2"));
    await h.controller.handle(stop("s1", "t3"));
    expect(store.getSession("s1")?.pendingUpdate).toBe(true);
    await h.controller.handle(stop("s1", "t4"));

    expect(h.updates).toHaveLength(2);
    expect(store.getSession("s1")).toEqual(expect.objectContaining({
      stopCount: 4,
      pendingUpdate: false,
      lastAutoTitle: "成功タイトル",
    }));
    expect(h.logs).toEqual(["title_update_failed"]);
  });

  test("null transcriptでserviceがpendingを残した場合も次Stopで再試行する", async () => {
    const store = openStore();
    const h = harness({
      every: 1,
      store,
      async update(input) {
        store.markPending(input.sessionId, "pending");
        throw new Error("missing transcript");
      },
    });

    await h.controller.handle(stop("s1", "t1", null));
    await h.controller.handle(stop("s1", "t2", null));

    expect(h.updates).toEqual([
      { sessionId: "s1", transcriptPath: undefined, force: false },
      { sessionId: "s1", transcriptPath: undefined, force: false },
    ]);
    expect(store.getSession("s1")?.pendingUpdate).toBe(true);
  });

  test("停止済みsessionもStop数は記録するがserviceは呼ばない", async () => {
    const store = openStore();
    store.markAutoUpdateDisabled("s1", "disabled");
    const h = harness({ every: 1, store });

    await h.controller.handle(stop("s1", "t1"));
    await h.controller.handle(stop("s1", "t2"));

    expect(h.updates).toEqual([]);
    expect(store.getSession("s1")).toEqual(expect.objectContaining({
      stopCount: 2,
      autoUpdateDisabled: true,
    }));
  });

  test("別sessionのStop回数を完全に分離する", async () => {
    const h = harness({ every: 2 });

    await h.controller.handle(stop("s1", "t1"));
    await h.controller.handle(stop("s2", "t1"));
    await h.controller.handle(stop("s1", "t2"));
    await h.controller.handle(stop("s2", "t2"));

    expect(h.updates).toEqual([
      { sessionId: "s1", transcriptPath: "/tmp/rollout.jsonl", force: false },
      { sessionId: "s2", transcriptPath: "/tmp/rollout.jsonl", force: false },
    ]);
    expect((h.store as StateStore).getSession("s1")?.stopCount).toBe(2);
    expect((h.store as StateStore).getSession("s2")?.stopCount).toBe(2);
  });

  test("service失敗は握りつぶし固定分類だけをログする", async () => {
    const h = harness({ every: 1, async update() { throw new Error("transcript-secret"); } });

    await expect(h.controller.handle(stop("s1", "t1"))).resolves.toBeUndefined();

    expect(h.logs).toEqual(["title_update_failed"]);
  });

  test.each([
    ["store", { recordStop() { throw new Error("database-secret"); } }, (): string => NOW],
    ["clock", { recordStop() { throw new Error("must not call"); } }, (): string => { throw new Error("clock-secret"); }],
  ] as const)("%s失敗を安全に握りつぶす", async (_name, store, clock) => {
    const h = harness({ store, clock });

    await expect(h.controller.handle(stop("s1", "t1"))).resolves.toBeUndefined();
    expect(h.logs).toEqual(["state_store_failed"]);
    expect(h.updates).toEqual([]);
  });

  test("logger自体がthrowしてもHook処理を妨げない", async () => {
    const h = harness({
      every: 1,
      async update() { throw new Error("service-secret"); },
      logger() { throw new Error("logger-secret"); },
    });

    await expect(h.controller.handle(stop("s1", "t1"))).resolves.toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import {
  TitleUpdateError,
  TitleUpdateService,
  type TitleUpdateStateStore,
  type TitleUpdateTranscriptReader,
} from "../src/title-update-service";
import type { NormalizedMessage, SessionState, TitleProvider, TitleProviderInput } from "../src/types";

const NOW = "2026-08-02T00:00:00.000Z";
const TRANSCRIPT_PATH = "/tmp/titlize-rollout.jsonl";
const MESSAGES: NormalizedMessage[] = [
  { role: "user", content: "認証エラーを直して" },
  { role: "assistant", content: "認証エラーを修正しました" },
];

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "s1",
    stopCount: 3,
    lastTurnId: "t3",
    pendingUpdate: false,
    lastAutoTitle: null,
    autoUpdateDisabled: false,
    lastSuccessAt: null,
    updatedAt: "before",
    ...overrides,
  };
}

class FakeStore implements TitleUpdateStateStore {
  state: SessionState | undefined;
  readonly calls: string[];
  failOn?: "getSession" | "markPending" | "markSuccess" | "markForcedSuccess" | "markAutoUpdateDisabled";

  constructor(initial: SessionState | undefined, calls: string[]) {
    this.state = initial;
    this.calls = calls;
  }

  getSession(sessionId: string): SessionState | undefined {
    this.calls.push("getSession");
    if (this.failOn === "getSession") throw new Error("state-secret");
    return this.state?.sessionId === sessionId ? structuredClone(this.state) : undefined;
  }

  markPending(sessionId: string, now: string): SessionState {
    this.calls.push("markPending");
    if (this.failOn === "markPending") throw new Error("state-secret");
    this.state = this.nextState(sessionId, { pendingUpdate: true, updatedAt: now });
    return structuredClone(this.state);
  }

  markSuccess(sessionId: string, title: string, now: string): SessionState {
    this.calls.push("markSuccess");
    if (this.failOn === "markSuccess") throw new Error("state-secret");
    this.state = this.nextState(sessionId, {
      pendingUpdate: false,
      lastAutoTitle: title,
      lastSuccessAt: now,
      updatedAt: now,
    });
    return structuredClone(this.state);
  }

  markForcedSuccess(sessionId: string, title: string, now: string): SessionState {
    this.calls.push("markForcedSuccess");
    if (this.failOn === "markForcedSuccess") throw new Error("state-secret");
    this.state = this.nextState(sessionId, {
      pendingUpdate: false,
      lastAutoTitle: title,
      autoUpdateDisabled: false,
      lastSuccessAt: now,
      updatedAt: now,
    });
    return structuredClone(this.state);
  }

  markAutoUpdateDisabled(sessionId: string, now: string): SessionState {
    this.calls.push("markAutoUpdateDisabled");
    if (this.failOn === "markAutoUpdateDisabled") throw new Error("state-secret");
    this.state = this.nextState(sessionId, {
      pendingUpdate: false,
      autoUpdateDisabled: true,
      updatedAt: now,
    });
    return structuredClone(this.state);
  }

  private nextState(sessionId: string, overrides: Partial<SessionState>): SessionState {
    return session({
      sessionId,
      stopCount: this.state?.stopCount ?? 0,
      lastTurnId: this.state?.lastTurnId ?? null,
      lastAutoTitle: this.state?.lastAutoTitle ?? null,
      autoUpdateDisabled: this.state?.autoUpdateDisabled ?? false,
      lastSuccessAt: this.state?.lastSuccessAt ?? null,
      ...overrides,
    });
  }
}

interface HarnessOptions {
  initial?: SessionState;
  currentTitle?: string;
  candidate?: unknown;
  messages?: NormalizedMessage[];
  readerFailure?: unknown;
  conversationFailure?: unknown;
  readTitleFailure?: unknown;
  providerFailure?: unknown;
  setTitleFailure?: unknown;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const store = new FakeStore(options.initial ?? session(), calls);
  const providerInputs: TitleProviderInput[] = [];
  const readerPaths: string[] = [];
  const setTitles: Array<{ sessionId: string; title: string }> = [];
  const provider: TitleProvider = {
    async generateTitle(input) {
      calls.push("generateTitle");
      providerInputs.push(structuredClone(input));
      if (options.providerFailure !== undefined) throw options.providerFailure;
      return (options.candidate ?? "認証エラー修正") as string;
    },
  };
  const transcriptReader: TitleUpdateTranscriptReader = {
    async read(path) {
      calls.push("readTranscript");
      readerPaths.push(path);
      if (options.readerFailure !== undefined) throw options.readerFailure;
      return options.messages ?? structuredClone(MESSAGES);
    },
  };
  const sink = {
    async readTitle(_sessionId: string): Promise<string | undefined> {
      calls.push("readTitle");
      if (options.readTitleFailure !== undefined) throw options.readTitleFailure;
      return options.currentTitle;
    },
    async readConversation(_sessionId: string): Promise<NormalizedMessage[]> {
      calls.push("readConversation");
      if (options.conversationFailure !== undefined) throw options.conversationFailure;
      return options.messages ?? structuredClone(MESSAGES);
    },
    async setTitle(sessionId: string, title: string): Promise<void> {
      calls.push("setTitle");
      setTitles.push({ sessionId, title });
      if (options.setTitleFailure !== undefined) throw options.setTitleFailure;
    },
  };
  const service = new TitleUpdateService({
    store,
    provider,
    transcriptReader,
    sink,
    maxChars: 40,
    clock: () => NOW,
  });
  return { service, store, calls, providerInputs, readerPaths, setTitles };
}

describe("TitleUpdateService", () => {
  test("通常更新を所定の順序で行いProviderへ正確な入力を渡す", async () => {
    const h = harness({ currentTitle: "既存タイトル" });

    await expect(h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    })).resolves.toEqual({ status: "updated" });

    expect(h.calls).toEqual([
      "getSession",
      "markPending",
      "readTitle",
      "readTranscript",
      "generateTitle",
      "setTitle",
      "markSuccess",
    ]);
    expect(h.readerPaths).toEqual([TRANSCRIPT_PATH]);
    expect(h.providerInputs).toEqual([{
      messages: MESSAGES,
      previousTitle: "既存タイトル",
      locale: "ja",
      maxChars: 40,
    }]);
    expect(h.setTitles).toEqual([{ sessionId: "s1", title: "認証エラー修正" }]);
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: false,
      lastAutoTitle: "認証エラー修正",
      lastSuccessAt: NOW,
    }));
  });

  test("初回更新では既存タイトルを手動変更とみなさない", async () => {
    const h = harness({
      initial: session({ lastAutoTitle: null }),
      currentTitle: "Codexが付けた既存名",
    });

    await expect(h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    })).resolves.toEqual({ status: "updated" });

    expect(h.calls).toContain("generateTitle");
    expect(h.calls).not.toContain("markAutoUpdateDisabled");
  });

  test("検証後の候補が現在名と同じなら書込みを省略して所有権を記録する", async () => {
    const h = harness({ currentTitle: "認証エラー修正", candidate: "# 認証エラー修正\n" });

    await expect(h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    })).resolves.toEqual({ status: "unchanged" });

    expect(h.calls).toEqual([
      "getSession", "markPending", "readTitle", "readTranscript", "generateTitle", "markSuccess",
    ]);
    expect(h.setTitles).toEqual([]);
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: false,
      lastAutoTitle: "認証エラー修正",
    }));
  });

  test.each([
    ["別名", "手動タイトル"],
    ["削除", undefined],
  ] as const)("前回自動名からの手動変更（%s）を検出して永久停止する", async (_name, currentTitle) => {
    const h = harness({
      initial: session({ lastAutoTitle: "前回の自動名", pendingUpdate: true }),
      currentTitle,
    });

    await expect(h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    })).resolves.toEqual({ status: "manual-change" });

    expect(h.calls).toEqual(["getSession", "markPending", "readTitle", "markAutoUpdateDisabled"]);
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: false,
      autoUpdateDisabled: true,
      lastAutoTitle: "前回の自動名",
    }));
  });

  test("停止済みの通常更新は外部処理も状態書込みも行わない", async () => {
    const h = harness({ initial: session({ autoUpdateDisabled: true, lastAutoTitle: "自動名" }) });

    await expect(h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    })).resolves.toEqual({ status: "disabled" });

    expect(h.calls).toEqual(["getSession"]);
  });

  test.each([
    ["現在名取得", { readTitleFailure: new Error("title-secret") }, "readTitle"],
    ["Transcript", { readerFailure: new Error("transcript-secret") }, "readTranscript"],
    ["Provider", { providerFailure: new Error("prompt-secret") }, "generateTitle"],
    ["Validator", { candidate: "" }, "generateTitle"],
    ["タイトル保存", { setTitleFailure: new Error("title-secret") }, "setTitle"],
  ] as const)("%s失敗ではpendingを維持し成功状態にしない", async (_name, options, expectedCall) => {
    const h = harness(options);

    const rejection = h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    });
    await expect(rejection).rejects.toBeInstanceOf(TitleUpdateError);
    await expect(rejection).rejects.not.toThrow(/secret|Transcript|prompt/);
    expect(h.calls).toContain(expectedCall);
    expect(h.calls).not.toContain("markSuccess");
    expect(h.calls).not.toContain("markForcedSuccess");
    expect(h.store.state).toEqual(expect.objectContaining({ pendingUpdate: true }));
  });

  test("通常更新でTranscriptパスがなければpendingを残しApp Server会話へfallbackしない", async () => {
    const h = harness({ currentTitle: "既存タイトル" });

    const rejection = h.service.update({ sessionId: "s1", force: false });
    await expect(rejection).rejects.toBeInstanceOf(TitleUpdateError);
    expect(h.calls).toEqual(["getSession", "markPending", "readTitle"]);
    expect(h.store.state).toEqual(expect.objectContaining({ pendingUpdate: true }));
  });

  test("forceは停止と手動変更判定を迂回し、明示Transcriptで停止を解除する", async () => {
    const h = harness({
      initial: session({ autoUpdateDisabled: true, lastAutoTitle: "前回の自動名" }),
      currentTitle: "手動タイトル",
      candidate: "強制タイトル",
    });

    await expect(h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: true,
    })).resolves.toEqual({ status: "updated" });

    expect(h.calls).toEqual([
      "getSession", "markPending", "readTitle", "readTranscript", "generateTitle", "setTitle", "markForcedSuccess",
    ]);
    expect(h.calls).not.toContain("markAutoUpdateDisabled");
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: false,
      lastAutoTitle: "強制タイトル",
      autoUpdateDisabled: false,
    }));
  });

  test("forceでTranscript未指定ならApp Server会話を使う", async () => {
    const h = harness({ currentTitle: "既存タイトル", candidate: "強制タイトル" });

    await expect(h.service.update({ sessionId: "s1", force: true })).resolves.toEqual({ status: "updated" });

    expect(h.calls).toEqual([
      "getSession", "markPending", "readTitle", "readConversation", "generateTitle", "setTitle", "markForcedSuccess",
    ]);
    expect(h.readerPaths).toEqual([]);
  });

  test("forceのApp Server会話取得失敗でもpendingを維持する", async () => {
    const h = harness({ conversationFailure: new Error("conversation-secret") });

    const rejection = h.service.update({ sessionId: "s1", force: true });
    await expect(rejection).rejects.toBeInstanceOf(TitleUpdateError);
    await expect(rejection).rejects.not.toThrow(/secret/);
    expect(h.store.state).toEqual(expect.objectContaining({ pendingUpdate: true }));
    expect(h.calls).not.toContain("markForcedSuccess");
  });

  test("force同名でもsetを省略しmarkForcedSuccessで停止を解除する", async () => {
    const h = harness({
      initial: session({ autoUpdateDisabled: true }),
      currentTitle: "同じタイトル",
      candidate: "**同じタイトル**",
    });

    await expect(h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: true,
    })).resolves.toEqual({ status: "unchanged" });

    expect(h.calls).not.toContain("setTitle");
    expect(h.calls.at(-1)).toBe("markForcedSuccess");
    expect(h.store.state?.autoUpdateDisabled).toBe(false);
  });

  test.each([
    ["非object", null],
    ["session欠落", { force: false }],
    ["空session", { sessionId: "", force: false }],
    ["長すぎるsession", { sessionId: "s".repeat(4097), force: false }],
    ["NUL session", { sessionId: "s\0secret", force: false }],
    ["force欠落", { sessionId: "s1" }],
    ["force型不正", { sessionId: "s1", force: "false" }],
    ["相対path", { sessionId: "s1", transcriptPath: "secret.jsonl", force: false }],
    ["空path", { sessionId: "s1", transcriptPath: "", force: false }],
    ["長すぎるpath", { sessionId: "s1", transcriptPath: `/${"p".repeat(4096)}`, force: false }],
    ["NUL path", { sessionId: "s1", transcriptPath: "/tmp/secret\0.jsonl", force: false }],
    ["余計なkey", { sessionId: "s1", force: false, secret: "value" }],
  ] as const)("不正なruntime入力（%s）を依存呼出し前に安全に拒否する", async (_name, input) => {
    const h = harness();

    const rejection = h.service.update(input);
    await expect(rejection).rejects.toBeInstanceOf(TitleUpdateError);
    await expect(rejection).rejects.toThrow("title update request is invalid");
    await expect(rejection).rejects.not.toThrow(/secret|jsonl/);
    expect(h.calls).toEqual([]);
  });

  test("必須値をProxyの継承風getterから補完しない", async () => {
    const h = harness();
    const input = new Proxy(
      { force: false },
      {
        get(target, key, receiver) {
          if (key === "sessionId") return "s1";
          return Reflect.get(target, key, receiver);
        },
      },
    );

    await expect(h.service.update(input)).rejects.toBeInstanceOf(TitleUpdateError);
    expect(h.calls).toEqual([]);
  });

  test("入力と依存から返されたmessagesを変更しない", async () => {
    const messages = structuredClone(MESSAGES);
    const input = { sessionId: "s1", transcriptPath: TRANSCRIPT_PATH, force: false } as const;
    const originalInput = structuredClone(input);
    const originalMessages = structuredClone(messages);
    const h = harness({ messages });

    await h.service.update(input);

    expect(input).toEqual(originalInput);
    expect(messages).toEqual(originalMessages);
  });

  test.each([
    ["getSession", "getSession"],
    ["markPending", "markPending"],
    ["markSuccess", "markSuccess"],
  ] as const)("状態書込み・取得失敗（%s）を隠さず安全に伝播する", async (_name, failOn) => {
    const h = harness();
    h.store.failOn = failOn;

    const rejection = h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    });
    await expect(rejection).rejects.toBeInstanceOf(TitleUpdateError);
    await expect(rejection).rejects.not.toThrow(/state-secret/);
  });
});

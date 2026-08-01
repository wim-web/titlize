import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state-store";
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
    pendingTitle: null,
    pendingPreviousTitle: null,
    pendingPreviousTitleKnown: false,
    autoUpdateDisabled: false,
    lastSuccessAt: null,
    updatedAt: "before",
    ...overrides,
  };
}

class FakeStore implements TitleUpdateStateStore {
  state: SessionState | undefined;
  readonly calls: string[];
  failOn?:
    | "getSession"
    | "markPending"
    | "markTitleWritePending"
    | "clearTitleWritePending"
    | "markSuccess"
    | "markForcedSuccess"
    | "markAutoUpdateDisabled";

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
      pendingTitle: null,
      pendingPreviousTitle: null,
      pendingPreviousTitleKnown: false,
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
      pendingTitle: null,
      pendingPreviousTitle: null,
      pendingPreviousTitleKnown: false,
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
      pendingTitle: null,
      pendingPreviousTitle: null,
      pendingPreviousTitleKnown: false,
      autoUpdateDisabled: true,
      updatedAt: now,
    });
    return structuredClone(this.state);
  }

  markTitleWritePending(
    sessionId: string,
    title: string,
    previousTitle: string | null,
    now: string,
  ): SessionState {
    this.calls.push("markTitleWritePending");
    if (this.failOn === "markTitleWritePending") throw new Error("state-secret");
    this.state = this.nextState(sessionId, {
      pendingUpdate: true,
      pendingTitle: title,
      pendingPreviousTitle: previousTitle,
      pendingPreviousTitleKnown: true,
      updatedAt: now,
    });
    return structuredClone(this.state);
  }

  clearTitleWritePending(sessionId: string, now: string): SessionState {
    this.calls.push("clearTitleWritePending");
    if (this.failOn === "clearTitleWritePending") throw new Error("state-secret");
    this.state = this.nextState(sessionId, {
      pendingUpdate: true,
      pendingTitle: null,
      pendingPreviousTitle: null,
      pendingPreviousTitleKnown: false,
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
      pendingTitle: this.state?.pendingTitle ?? null,
      pendingPreviousTitle: this.state?.pendingPreviousTitle ?? null,
      pendingPreviousTitleKnown: this.state?.pendingPreviousTitleKnown ?? false,
      autoUpdateDisabled: this.state?.autoUpdateDisabled ?? false,
      lastSuccessAt: this.state?.lastSuccessAt ?? null,
      ...overrides,
    });
  }
}

interface HarnessOptions {
  initial?: SessionState;
  currentTitle?: string;
  currentTitleRef?: { value: string | undefined };
  titleReadResults?: Array<string | undefined | Error>;
  candidate?: unknown;
  messages?: NormalizedMessage[];
  readerFailure?: unknown;
  conversationFailure?: unknown;
  readTitleFailure?: unknown;
  providerFailure?: unknown;
  providerGate?: Promise<void>;
  setTitleFailure?: unknown;
  setTitleOutcomes?: Array<{ apply: boolean; error?: unknown }>;
}

function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const store = new FakeStore(options.initial ?? session(), calls);
  const providerInputs: TitleProviderInput[] = [];
  const readerPaths: string[] = [];
  const setTitles: Array<{ sessionId: string; title: string }> = [];
  const currentTitleRef = options.currentTitleRef ?? { value: options.currentTitle };
  const titleReadResults = options.titleReadResults?.slice();
  const setTitleOutcomes = options.setTitleOutcomes?.slice();
  const provider: TitleProvider = {
    async generateTitle(input) {
      calls.push("generateTitle");
      providerInputs.push(structuredClone(input));
      if (options.providerFailure !== undefined) throw options.providerFailure;
      if (options.providerGate !== undefined) await options.providerGate;
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
      const next = titleReadResults?.shift();
      if (next instanceof Error) throw next;
      return titleReadResults === undefined ? currentTitleRef.value : next;
    },
    async readConversation(_sessionId: string): Promise<NormalizedMessage[]> {
      calls.push("readConversation");
      if (options.conversationFailure !== undefined) throw options.conversationFailure;
      return options.messages ?? structuredClone(MESSAGES);
    },
    async setTitle(sessionId: string, title: string): Promise<void> {
      calls.push("setTitle");
      setTitles.push({ sessionId, title });
      const outcome = setTitleOutcomes?.shift();
      const failure = outcome?.error ?? options.setTitleFailure;
      if (outcome?.apply === true || failure === undefined) currentTitleRef.value = title;
      if (failure !== undefined) throw failure;
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
  return { service, store, calls, providerInputs, readerPaths, setTitles, currentTitleRef };
}

async function waitForCall(calls: string[], expected: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (calls.includes(expected)) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

function openIntermediateIntentStore(options: {
  sessionId: string;
  lastAutoTitle: string | null;
  pendingTitle: string;
}): StateStore {
  const path = join(mkdtempSync(join(tmpdir(), "titlize-intermediate-")), "state.sqlite3");
  const legacy = new Database(path);
  try {
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
    `);
    legacy.query(
      `INSERT INTO sessions VALUES (?, 3, 't3', 1, ?, ?, 0, NULL, 'legacy-updated')`,
    ).run(options.sessionId, options.lastAutoTitle, options.pendingTitle);
  } finally {
    legacy.close();
  }
  return new StateStore(path);
}

function migratedStoreHarness(
  store: StateStore,
  currentTitleRef: { value: string | undefined },
  candidate: string,
) {
  const calls: string[] = [];
  const service = new TitleUpdateService({
    store,
    provider: {
      async generateTitle() {
        calls.push("generateTitle");
        return candidate;
      },
    },
    transcriptReader: {
      async read() {
        calls.push("readTranscript");
        return structuredClone(MESSAGES);
      },
    },
    sink: {
      async readTitle() {
        calls.push("readTitle");
        return currentTitleRef.value;
      },
      async readConversation() {
        throw new Error("unexpected conversation read");
      },
      async setTitle(_sessionId, title) {
        calls.push("setTitle");
        currentTitleRef.value = title;
      },
    },
    maxChars: 40,
    clock: () => NOW,
  });
  return { service, calls };
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
      "readTitle",
      "markTitleWritePending",
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
      "getSession", "markPending", "readTitle", "readTranscript", "generateTitle",
      "readTitle", "markSuccess",
    ]);
    expect(h.setTitles).toEqual([]);
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: false,
      lastAutoTitle: "認証エラー修正",
    }));
  });

  test.each([
    ["別候補", "生成タイトル"],
    ["生成前と同名候補", "A"],
  ] as const)("生成中の手動変更を再確認して上書きしない: %s", async (_name, candidate) => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const currentTitleRef: { value: string | undefined } = { value: "A" };
    const h = harness({
      initial: session({ lastAutoTitle: "A" }),
      currentTitleRef,
      candidate,
      providerGate,
    });

    const update = h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    });
    await waitForCall(h.calls, "generateTitle");
    currentTitleRef.value = "M";
    releaseProvider();

    await expect(update).resolves.toEqual({ status: "manual-change" });
    expect(h.calls).toEqual([
      "getSession", "markPending", "readTitle", "readTranscript", "generateTitle",
      "readTitle", "markAutoUpdateDisabled",
    ]);
    expect(h.calls).not.toContain("markTitleWritePending");
    expect(h.calls).not.toContain("setTitle");
    expect(h.calls).not.toContain("markSuccess");
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: false,
      pendingTitle: null,
      autoUpdateDisabled: true,
      lastAutoTitle: "A",
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

  test("生成後の現在名再取得失敗ではintentを書かずpendingを維持する", async () => {
    const h = harness({
      initial: session({ lastAutoTitle: "A" }),
      titleReadResults: ["A", new Error("second-read-secret")],
      candidate: "B",
    });

    const rejection = h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    });
    await expect(rejection).rejects.toBeInstanceOf(TitleUpdateError);
    await expect(rejection).rejects.not.toThrow(/secret/);
    expect(h.calls).not.toContain("markTitleWritePending");
    expect(h.calls).not.toContain("setTitle");
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: true,
      pendingTitle: null,
    }));
  });

  test("書込みintent永続化に失敗したらsetTitleを呼ばない", async () => {
    const h = harness({ currentTitle: "A", candidate: "B" });
    h.store.failOn = "markTitleWritePending";

    const rejection = h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    });
    await expect(rejection).rejects.toBeInstanceOf(TitleUpdateError);
    expect(h.calls).toContain("markTitleWritePending");
    expect(h.calls).not.toContain("setTitle");
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: true,
      pendingTitle: null,
    }));
  });

  test("setTitle失敗で未適用なら次回intentをclearして通常生成を再試行する", async () => {
    const currentTitleRef: { value: string | undefined } = { value: "A" };
    const h = harness({
      initial: session({ lastAutoTitle: "A" }),
      currentTitleRef,
      candidate: "B",
      setTitleOutcomes: [{ apply: false, error: new Error("set-secret") }],
    });
    const request = { sessionId: "s1", transcriptPath: TRANSCRIPT_PATH, force: false } as const;

    await expect(h.service.update(request)).rejects.toBeInstanceOf(TitleUpdateError);
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: true,
      pendingTitle: "B",
      pendingPreviousTitle: "A",
      lastAutoTitle: "A",
    }));
    expect(currentTitleRef.value).toBe("A");
    h.calls.length = 0;

    await expect(h.service.update(request)).resolves.toEqual({ status: "updated" });
    expect(h.calls).toEqual([
      "getSession", "markPending", "readTitle", "clearTitleWritePending",
      "readTranscript", "generateTitle", "readTitle", "markTitleWritePending",
      "setTitle", "markSuccess",
    ]);
    expect(h.providerInputs).toHaveLength(2);
    expect(currentTitleRef.value).toBe("B");
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: false,
      pendingTitle: null,
      pendingPreviousTitle: null,
      lastAutoTitle: "B",
    }));
  });

  test("setTitle適用後の応答喪失は次回intent照合だけで成功回復する", async () => {
    const currentTitleRef: { value: string | undefined } = { value: "A" };
    const h = harness({
      initial: session({ lastAutoTitle: "A" }),
      currentTitleRef,
      candidate: "B",
      setTitleOutcomes: [{ apply: true, error: new Error("response-secret") }],
    });
    const request = { sessionId: "s1", transcriptPath: TRANSCRIPT_PATH, force: false } as const;

    await expect(h.service.update(request)).rejects.toBeInstanceOf(TitleUpdateError);
    expect(currentTitleRef.value).toBe("B");
    expect(h.store.state?.pendingTitle).toBe("B");
    expect(h.store.state?.pendingPreviousTitle).toBe("A");
    h.calls.length = 0;

    await expect(h.service.update(request)).resolves.toEqual({ status: "unchanged" });
    expect(h.calls).toEqual(["getSession", "markPending", "readTitle", "markSuccess"]);
    expect(h.providerInputs).toHaveLength(1);
    expect(h.setTitles).toHaveLength(1);
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: false,
      pendingTitle: null,
      pendingPreviousTitle: null,
      lastAutoTitle: "B",
    }));
  });

  test("setTitle成功後のmarkSuccess失敗を次回intent照合だけで回復する", async () => {
    const currentTitleRef: { value: string | undefined } = { value: "A" };
    const h = harness({
      initial: session({ lastAutoTitle: "A" }),
      currentTitleRef,
      candidate: "B",
    });
    const request = { sessionId: "s1", transcriptPath: TRANSCRIPT_PATH, force: false } as const;
    h.store.failOn = "markSuccess";

    await expect(h.service.update(request)).rejects.toBeInstanceOf(TitleUpdateError);
    expect(currentTitleRef.value).toBe("B");
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: true,
      pendingTitle: "B",
      pendingPreviousTitle: "A",
      lastAutoTitle: "A",
    }));
    h.store.failOn = undefined;
    h.calls.length = 0;

    await expect(h.service.update(request)).resolves.toEqual({ status: "unchanged" });
    expect(h.calls).toEqual(["getSession", "markPending", "readTitle", "markSuccess"]);
    expect(h.providerInputs).toHaveLength(1);
    expect(h.setTitles).toHaveLength(1);
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: false,
      pendingTitle: null,
      pendingPreviousTitle: null,
      lastAutoTitle: "B",
    }));
  });

  test("intent・前回自動名のどちらとも異なる現在名は手動変更として停止する", async () => {
    const h = harness({
      initial: session({
        lastAutoTitle: "A",
        pendingTitle: "B",
        pendingPreviousTitle: "A",
        pendingPreviousTitleKnown: true,
        pendingUpdate: true,
      }),
      currentTitle: "M",
    });

    await expect(h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    })).resolves.toEqual({ status: "manual-change" });
    expect(h.calls).toEqual(["getSession", "markPending", "readTitle", "markAutoUpdateDisabled"]);
    expect(h.calls).not.toContain("generateTitle");
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: false,
      pendingTitle: null,
      pendingPreviousTitle: null,
      autoUpdateDisabled: true,
    }));
  });

  test("初回intent未適用はintentをclearして通常生成を再試行する", async () => {
    const h = harness({
      initial: session({
        lastAutoTitle: null,
        pendingTitle: "B",
        pendingPreviousTitle: "既存タイトル",
        pendingPreviousTitleKnown: true,
        pendingUpdate: true,
      }),
      currentTitle: "既存タイトル",
      candidate: "C",
    });

    await expect(h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    })).resolves.toEqual({ status: "updated" });
    expect(h.calls).toContain("clearTitleWritePending");
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingTitle: null,
      pendingPreviousTitle: null,
      lastAutoTitle: "C",
    }));
  });

  test("初回書込み適用後に成功記録が失敗し手動変更されたら上書きせず停止する", async () => {
    const currentTitleRef: { value: string | undefined } = { value: "A" };
    const h = harness({
      initial: session({ lastAutoTitle: null }),
      currentTitleRef,
      candidate: "B",
    });
    const request = { sessionId: "s1", transcriptPath: TRANSCRIPT_PATH, force: false } as const;
    h.store.failOn = "markSuccess";

    await expect(h.service.update(request)).rejects.toBeInstanceOf(TitleUpdateError);
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: true,
      pendingTitle: "B",
      pendingPreviousTitle: "A",
      lastAutoTitle: null,
    }));
    currentTitleRef.value = "M";
    h.store.failOn = undefined;
    h.calls.length = 0;

    await expect(h.service.update(request)).resolves.toEqual({ status: "manual-change" });
    expect(h.calls).toEqual(["getSession", "markPending", "readTitle", "markAutoUpdateDisabled"]);
    expect(h.calls).not.toContain("generateTitle");
    expect(h.calls).not.toContain("setTitle");
    expect(currentTitleRef.value).toBe("M");
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: false,
      pendingTitle: null,
      pendingPreviousTitle: null,
      autoUpdateDisabled: true,
      lastAutoTitle: null,
    }));
  });

  test("変更前タイトルがnullの未適用intentはclearして通常生成を再試行する", async () => {
    const currentTitleRef: { value: string | undefined } = { value: undefined };
    const h = harness({
      initial: session({ lastAutoTitle: null }),
      currentTitleRef,
      candidate: "B",
      setTitleOutcomes: [{ apply: false, error: new Error("set-secret") }],
    });
    const request = { sessionId: "s1", transcriptPath: TRANSCRIPT_PATH, force: false } as const;

    await expect(h.service.update(request)).rejects.toBeInstanceOf(TitleUpdateError);
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: true,
      pendingTitle: "B",
      pendingPreviousTitle: null,
    }));
    h.calls.length = 0;

    await expect(h.service.update(request)).resolves.toEqual({ status: "updated" });
    expect(h.calls).toEqual([
      "getSession", "markPending", "readTitle", "clearTitleWritePending",
      "readTranscript", "generateTitle", "readTitle", "markTitleWritePending",
      "setTitle", "markSuccess",
    ]);
    expect(currentTitleRef.value).toBe("B");
  });

  test("旧DBの未適用intentはlastAutoTitleを変更前名へ復元して再試行する", async () => {
    const store = openIntermediateIntentStore({
      sessionId: "legacy-known",
      lastAutoTitle: "A",
      pendingTitle: "B",
    });
    const currentTitleRef: { value: string | undefined } = { value: "A" };
    const h = migratedStoreHarness(store, currentTitleRef, "C");

    try {
      expect(store.getSession("legacy-known")).toEqual(expect.objectContaining({
        stopCount: 3,
        lastTurnId: "t3",
        pendingTitle: "B",
        pendingPreviousTitle: "A",
        pendingPreviousTitleKnown: true,
      }));

      await expect(h.service.update({
        sessionId: "legacy-known",
        transcriptPath: TRANSCRIPT_PATH,
        force: false,
      })).resolves.toEqual({ status: "updated" });

      expect(h.calls).toEqual([
        "readTitle", "readTranscript", "generateTitle", "readTitle", "setTitle",
      ]);
      expect(currentTitleRef.value).toBe("C");
      expect(store.getSession("legacy-known")).toEqual(expect.objectContaining({
        stopCount: 3,
        lastTurnId: "t3",
        pendingUpdate: false,
        pendingTitle: null,
        pendingPreviousTitle: null,
        pendingPreviousTitleKnown: false,
        lastAutoTitle: "C",
        autoUpdateDisabled: false,
      }));
    } finally {
      store.close();
    }
  });

  test("変更前名を復元不能な旧初回intentは手動名を上書きせず停止する", async () => {
    const store = openIntermediateIntentStore({
      sessionId: "legacy-unknown",
      lastAutoTitle: null,
      pendingTitle: "B",
    });
    const currentTitleRef: { value: string | undefined } = { value: "M" };
    const h = migratedStoreHarness(store, currentTitleRef, "C");

    try {
      expect(store.getSession("legacy-unknown")).toEqual(expect.objectContaining({
        pendingTitle: "B",
        pendingPreviousTitle: null,
        pendingPreviousTitleKnown: false,
      }));

      await expect(h.service.update({
        sessionId: "legacy-unknown",
        transcriptPath: TRANSCRIPT_PATH,
        force: false,
      })).resolves.toEqual({ status: "manual-change" });

      expect(h.calls).toEqual(["readTitle"]);
      expect(currentTitleRef.value).toBe("M");
      expect(store.getSession("legacy-unknown")).toEqual(expect.objectContaining({
        stopCount: 3,
        lastTurnId: "t3",
        pendingUpdate: false,
        pendingTitle: null,
        pendingPreviousTitle: null,
        pendingPreviousTitleKnown: false,
        autoUpdateDisabled: true,
      }));
    } finally {
      store.close();
    }
  });

  test("変更前名を復元不能でも旧intent候補が適用済みなら成功回復する", async () => {
    const store = openIntermediateIntentStore({
      sessionId: "legacy-applied",
      lastAutoTitle: null,
      pendingTitle: "B",
    });
    const currentTitleRef: { value: string | undefined } = { value: "B" };
    const h = migratedStoreHarness(store, currentTitleRef, "unused");

    try {
      await expect(h.service.update({
        sessionId: "legacy-applied",
        transcriptPath: TRANSCRIPT_PATH,
        force: false,
      })).resolves.toEqual({ status: "unchanged" });

      expect(h.calls).toEqual(["readTitle"]);
      expect(store.getSession("legacy-applied")).toEqual(expect.objectContaining({
        stopCount: 3,
        lastTurnId: "t3",
        pendingUpdate: false,
        pendingTitle: null,
        pendingPreviousTitleKnown: false,
        lastAutoTitle: "B",
        autoUpdateDisabled: false,
      }));
    } finally {
      store.close();
    }
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
      "getSession", "markPending", "readTitle", "readTranscript", "generateTitle",
      "readTitle", "markTitleWritePending", "setTitle", "markForcedSuccess",
    ]);
    expect(h.calls).not.toContain("markAutoUpdateDisabled");
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: false,
      lastAutoTitle: "強制タイトル",
      autoUpdateDisabled: false,
    }));
  });

  test("forceは生成中の手動変更再確認を迂回して意図どおり上書きする", async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const currentTitleRef: { value: string | undefined } = { value: "A" };
    const h = harness({ currentTitleRef, candidate: "F", providerGate });
    const update = h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: true,
    });
    await waitForCall(h.calls, "generateTitle");
    currentTitleRef.value = "M";
    releaseProvider();

    await expect(update).resolves.toEqual({ status: "updated" });
    expect(h.calls.filter((call) => call === "readTitle")).toHaveLength(2);
    expect(h.setTitles).toEqual([{ sessionId: "s1", title: "F" }]);
    expect(currentTitleRef.value).toBe("F");
  });

  test("停止済みsessionのforce適用後に成功記録が失敗しても次回normalで解除回復する", async () => {
    const currentTitleRef: { value: string | undefined } = { value: "A" };
    const h = harness({
      initial: session({
        lastAutoTitle: "A",
        autoUpdateDisabled: true,
      }),
      currentTitleRef,
      candidate: "F",
    });
    h.store.failOn = "markForcedSuccess";

    await expect(h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: true,
    })).rejects.toBeInstanceOf(TitleUpdateError);
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: true,
      pendingTitle: "F",
      autoUpdateDisabled: true,
    }));
    expect(currentTitleRef.value).toBe("F");
    h.store.failOn = undefined;
    h.calls.length = 0;

    await expect(h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    })).resolves.toEqual({ status: "unchanged" });
    expect(h.calls).toEqual([
      "getSession", "markPending", "readTitle", "markForcedSuccess",
    ]);
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: false,
      pendingTitle: null,
      lastAutoTitle: "F",
      autoUpdateDisabled: false,
    }));
  });

  test("停止済みsessionのforce書込みが未適用ならintentを消して停止を維持する", async () => {
    const currentTitleRef: { value: string | undefined } = { value: "A" };
    const h = harness({
      initial: session({ lastAutoTitle: "A", autoUpdateDisabled: true }),
      currentTitleRef,
      candidate: "F",
      setTitleOutcomes: [{ apply: false, error: new Error("set-secret") }],
    });

    await expect(h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: true,
    })).rejects.toBeInstanceOf(TitleUpdateError);
    h.calls.length = 0;

    await expect(h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    })).resolves.toEqual({ status: "disabled" });
    expect(h.calls).toEqual([
      "getSession", "markPending", "readTitle", "markAutoUpdateDisabled",
    ]);
    expect(h.store.state).toEqual(expect.objectContaining({
      pendingUpdate: false,
      pendingTitle: null,
      lastAutoTitle: "A",
      autoUpdateDisabled: true,
    }));
  });

  test("forceでTranscript未指定ならApp Server会話を使う", async () => {
    const h = harness({ currentTitle: "既存タイトル", candidate: "強制タイトル" });

    await expect(h.service.update({ sessionId: "s1", force: true })).resolves.toEqual({ status: "updated" });

    expect(h.calls).toEqual([
      "getSession", "markPending", "readTitle", "readConversation", "generateTitle",
      "readTitle", "markTitleWritePending", "setTitle", "markForcedSuccess",
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

  test("getSession stateのgetter例外を外部処理前に安全なstate errorへ変換する", async () => {
    const h = harness();
    h.store.getSession = () => new Proxy(session(), {
      get(target, key, receiver) {
        if (key === "lastAutoTitle") throw new Error("state-getter-secret");
        return Reflect.get(target, key, receiver);
      },
    });

    const rejection = h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    });
    await expect(rejection).rejects.toBeInstanceOf(TitleUpdateError);
    await expect(rejection).rejects.toThrow("title update state operation failed");
    await expect(rejection).rejects.not.toThrow(/secret/);
    expect(h.calls).toEqual([]);
  });

  test("pendingPreviousTitleの不正値を外部処理前に安全なstate errorへ変換する", async () => {
    const h = harness();
    h.store.getSession = () => ({
      ...session(),
      pendingTitle: "candidate",
      pendingPreviousTitle: 42,
      pendingPreviousTitleKnown: true,
    }) as unknown as SessionState;

    const rejection = h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    });
    await expect(rejection).rejects.toBeInstanceOf(TitleUpdateError);
    await expect(rejection).rejects.toThrow("title update state operation failed");
    expect(h.calls).toEqual([]);
  });

  test("pendingPreviousTitleKnownの不正値を外部処理前に安全なstate errorへ変換する", async () => {
    const h = harness();
    h.store.getSession = () => ({
      ...session(),
      pendingTitle: "candidate",
      pendingPreviousTitle: null,
      pendingPreviousTitleKnown: 1,
    }) as unknown as SessionState;

    await expect(h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    })).rejects.toEqual(TitleUpdateError.for("state_failed"));
    expect(h.calls).toEqual([]);
  });

  test("候補のない孤立したpendingPreviousTitleを不正stateとして拒否する", async () => {
    const h = harness();
    h.store.getSession = () => session({ pendingPreviousTitle: "orphan" });

    await expect(h.service.update({
      sessionId: "s1",
      transcriptPath: TRANSCRIPT_PATH,
      force: false,
    })).rejects.toEqual(TitleUpdateError.for("state_failed"));
    expect(h.calls).toEqual([]);
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

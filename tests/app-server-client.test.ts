import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppServerClient,
  AppServerError,
  StdioAppServerTransportFactory,
  type AppServerTransport,
  type AppServerTransportFactory,
  type TransportOpenOptions,
} from "../src/app-server-client";

const initializeResult = {
  userAgent: "codex_cli_rs/0.145.0",
  codexHome: "/test/codex-home",
  platformFamily: "unix",
  platformOs: "macos",
};

class FakeTransport implements AppServerTransport {
  readonly writes: string[] = [];
  closeCalls = 0;
  cleanupFinished = false;

  constructor(
    private readonly responses: Array<unknown | Promise<unknown>>,
    private readonly closeDelayMs = 0,
  ) {}

  async writeLine(line: string): Promise<void> {
    this.writes.push(line);
  }

  async readMessage(): Promise<unknown> {
    if (this.responses.length === 0) return await new Promise<never>(() => {});
    return await this.responses.shift();
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeDelayMs > 0) await Bun.sleep(this.closeDelayMs);
    this.cleanupFinished = true;
  }
}

class FakeTransportFactory implements AppServerTransportFactory {
  openCalls = 0;
  lastOptions: TransportOpenOptions | undefined;

  constructor(
    readonly transport: FakeTransport,
    private readonly openError?: Error,
  ) {}

  async open(options: TransportOpenOptions): Promise<AppServerTransport> {
    this.openCalls += 1;
    this.lastOptions = options;
    if (this.openError) throw this.openError;
    return this.transport;
  }
}

function parseWrites(transport: FakeTransport): unknown[] {
  return transport.writes.map((line) => JSON.parse(line) as unknown);
}

describe("AppServerClient protocol", () => {
  test("initialize応答後にinitialized通知と対象requestを順番どおり送る", async () => {
    const transport = new FakeTransport([
      { method: "account/updated", params: { authMode: "chatgpt" } },
      { id: 1, result: initializeResult },
      { id: 77, method: "item/tool/requestUserInput", params: {} },
      { method: "remoteControl/available", params: {} },
      { id: 99, result: { ignored: true } },
      { id: 2, result: { thread: { name: "旧タイトル" } } },
    ]);
    const factory = new FakeTransportFactory(transport);
    const client = new AppServerClient({ timeoutMs: 1_000, transportFactory: factory });

    await expect(
      client.call("thread/read", { threadId: "session-1", includeTurns: false }),
    ).resolves.toEqual({ thread: { name: "旧タイトル" } });

    expect(parseWrites(transport)).toEqual([
      {
        method: "initialize",
        id: 1,
        params: {
          clientInfo: { name: "titlize", version: "0.1.0" },
          capabilities: { experimentalApi: false },
        },
      },
      { method: "initialized" },
      {
        method: "thread/read",
        id: 2,
        params: { threadId: "session-1", includeTurns: false },
      },
    ]);
    expect(transport.closeCalls).toBe(1);
    expect(factory.lastOptions?.signal).toBeInstanceOf(AbortSignal);
  });

  test("initialize応答を受ける前にはinitializedも対象requestも送らない", async () => {
    let resolveInitialize!: (value: unknown) => void;
    const delayedInitialize = new Promise<unknown>((resolve) => {
      resolveInitialize = resolve;
    });
    const transport = new FakeTransport([
      delayedInitialize,
      { id: 2, result: {} },
    ]);
    const client = new AppServerClient({
      timeoutMs: 1_000,
      transportFactory: new FakeTransportFactory(transport),
    });

    const call = client.call("thread/name/set", { threadId: "session-1", name: "新タイトル" });
    await Bun.sleep(5);
    expect(parseWrites(transport)).toEqual([
      {
        method: "initialize",
        id: 1,
        params: {
          clientInfo: { name: "titlize", version: "0.1.0" },
          capabilities: { experimentalApi: false },
        },
      },
    ]);

    resolveInitialize({ id: 1, result: initializeResult });
    await expect(call).resolves.toEqual({});
  });

  test("同じidのRPC errorを本文を漏らさない固定AppServerErrorへ変換する", async () => {
    const transport = new FakeTransport([
      { id: 1, result: initializeResult },
      {
        id: 2,
        error: {
          code: -32600,
          message: "thread not loaded: session-secret /private/sensitive/path",
        },
      },
    ]);
    const client = new AppServerClient({
      timeoutMs: 1_000,
      transportFactory: new FakeTransportFactory(transport),
    });

    try {
      await client.call("thread/read", { threadId: "session-secret", includeTurns: false });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AppServerError);
      expect(String(error)).toBe("AppServerError: app server request failed");
      expect(String(error)).not.toMatch(/secret|private|sensitive|-32600/);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
    expect(transport.closeCalls).toBe(1);
  });

  test("timeoutは待機を中断しtransportを閉じる", async () => {
    const transport = new FakeTransport([new Promise<never>(() => {})]);
    const client = new AppServerClient({
      timeoutMs: 20,
      transportFactory: new FakeTransportFactory(transport),
    });
    const startedAt = performance.now();

    const rejection = client.call("thread/read", { threadId: "session-1", includeTurns: false });
    await expect(rejection).rejects.toBeInstanceOf(AppServerError);
    await expect(rejection).rejects.toThrow("app server request timed out");
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(transport.closeCalls).toBe(1);
  });

  test("timeout後もbounded cleanup完了を待ってから返す", async () => {
    const transport = new FakeTransport([new Promise<never>(() => {})], 35);
    const client = new AppServerClient({
      timeoutMs: 10,
      transportFactory: new FakeTransportFactory(transport),
    });
    const startedAt = performance.now();

    await expect(
      client.call("thread/read", { threadId: "session-1", includeTurns: false }),
    ).rejects.toThrow("app server request timed out");

    expect(transport.cleanupFinished).toBe(true);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(30);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("transport open待機にもoperation timeoutを適用する", async () => {
    const factory: AppServerTransportFactory = {
      open: async () => await new Promise<never>(() => {}),
    };
    const client = new AppServerClient({ timeoutMs: 15, transportFactory: factory });
    const startedAt = performance.now();

    await expect(
      client.call("thread/read", { threadId: "session-1", includeTurns: false }),
    ).rejects.toThrow("app server request timed out");
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("stdin write待機にもoperation timeoutを適用してcleanupする", async () => {
    let closeCalls = 0;
    const transport: AppServerTransport = {
      writeLine: async () => await new Promise<never>(() => {}),
      readMessage: async () => await new Promise<never>(() => {}),
      close: async () => {
        closeCalls += 1;
      },
    };
    const factory: AppServerTransportFactory = { open: async () => transport };
    const client = new AppServerClient({ timeoutMs: 15, transportFactory: factory });

    await expect(
      client.call("thread/read", { threadId: "session-1", includeTurns: false }),
    ).rejects.toThrow("app server request timed out");
    expect(closeCalls).toBe(1);
  });

  test("正常response後のclose待機もtimeout対象にしcleanup完了を待つ", async () => {
    const transport = new FakeTransport(
      [
        { id: 1, result: initializeResult },
        { id: 2, result: { thread: { name: "title" } } },
      ],
      35,
    );
    const client = new AppServerClient({
      timeoutMs: 10,
      transportFactory: new FakeTransportFactory(transport),
    });

    await expect(
      client.call("thread/read", { threadId: "session-1", includeTurns: false }),
    ).rejects.toThrow("app server request timed out");
    expect(transport.cleanupFinished).toBe(true);
  });

  test.each([
    ["malformed message", [42]],
    ["invalid initialize response", [{ id: 1, result: { userAgent: "missing-fields" } }]],
    ["target response without result", [{ id: 1, result: initializeResult }, { id: 2 }]],
  ] as const)("%sをprotocol errorへ変換する", async (_name, responses) => {
    const transport = new FakeTransport([...responses]);
    const client = new AppServerClient({
      timeoutMs: 100,
      transportFactory: new FakeTransportFactory(transport),
    });

    await expect(
      client.call("thread/read", { threadId: "session-1", includeTurns: false }),
    ).rejects.toThrow("app server returned an invalid response");
  });

  test("spawn/open例外の秘密・path・causeを公開しない", async () => {
    const transport = new FakeTransport([]);
    const factory = new FakeTransportFactory(
      transport,
      new Error("spawn secret at /private/sensitive/codex"),
    );
    const client = new AppServerClient({ timeoutMs: 100, transportFactory: factory });

    try {
      await client.call("thread/read", { threadId: "session-1", includeTurns: false });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AppServerError);
      expect(String(error)).not.toMatch(/secret|private|sensitive|codex/);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  test.each([
    ["unknown method", "thread/delete", { threadId: "session-secret" }],
    ["NUL thread id", "thread/read", { threadId: "session-secret\0", includeTurns: false }],
    ["empty thread id", "thread/read", { threadId: "", includeTurns: false }],
    ["oversize thread id", "thread/read", { threadId: "x".repeat(4_097), includeTurns: false }],
    ["invalid includeTurns", "thread/read", { threadId: "s1", includeTurns: "false" }],
    ["unexpected params", "thread/read", { threadId: "s1", includeTurns: false, secret: "x" }],
    ["empty title", "thread/name/set", { threadId: "s1", name: "" }],
    ["oversize title", "thread/name/set", { threadId: "s1", name: "x".repeat(4_097) }],
  ])("spawn前に安全に拒否する: %s", async (_name, method, params) => {
    const factory = new FakeTransportFactory(new FakeTransport([]));
    const client = new AppServerClient({ timeoutMs: 100, transportFactory: factory });

    const rejection = client.call(method as "thread/read", params);
    await expect(rejection).rejects.toBeInstanceOf(AppServerError);
    await expect(rejection).rejects.toThrow("app server request is invalid");
    await expect(rejection).rejects.not.toThrow(/secret/);
    expect(factory.openCalls).toBe(0);
  });

  test("循環参照を含むparamsをspawn前に拒否する", async () => {
    const factory = new FakeTransportFactory(new FakeTransport([]));
    const client = new AppServerClient({ timeoutMs: 100, transportFactory: factory });
    const params: Record<string, unknown> = {
      threadId: "cycle-secret",
      includeTurns: false,
    };
    params.self = params;

    await expect(client.call("thread/read", params)).rejects.toBeInstanceOf(AppServerError);
    expect(factory.openCalls).toBe(0);
  });
});

describe("StdioAppServerTransportFactory", () => {
  const helperPath = join(import.meta.dir, "helpers", "app-server-worker.ts");

  test("stderrを並列drainしてJSONL responseを返す", async () => {
    const client = new AppServerClient({
      timeoutMs: 2_000,
      transportFactory: new StdioAppServerTransportFactory({
        command: process.execPath,
        args: [helperPath, "large-stderr"],
        maxStderrBytes: 2 * 1024 * 1024,
      }),
    });

    await expect(
      client.call("thread/read", { threadId: "session-1", includeTurns: false }),
    ).resolves.toEqual({ thread: { name: "helper-title" } });
  });

  test("1 chunk内の複数短JSONL行をline上限超過と誤判定しない", async () => {
    const client = new AppServerClient({
      timeoutMs: 2_000,
      transportFactory: new StdioAppServerTransportFactory({
        command: process.execPath,
        args: [helperPath, "multi-line-chunk"],
        maxStdoutLineBytes: 256,
        maxStdoutBytes: 4_096,
        // 13 messages are emitted. The pending receiver takes one and the remaining 12 fit
        // exactly, which also catches accidental duplicate delivery.
        maxQueuedMessages: 12,
      }),
    });

    await expect(
      client.call("thread/read", { threadId: "session-1", includeTurns: false }),
    ).resolves.toEqual({ thread: { name: "helper-title" } });
  });

  test.each([
    ["malformed", "app server returned an invalid response", 256, 4_096, 32],
    ["oversize-line", "app server output exceeded the safety limit", 128, 4_096, 32],
    ["oversize-total", "app server output exceeded the safety limit", 256, 512, 32],
    ["queue-overflow", "app server output exceeded the safety limit", 256, 4_096, 4],
  ] as const)(
    "%s stdoutを安全な分類済みerrorへ変換する",
    async (mode, expectedMessage, maxStdoutLineBytes, maxStdoutBytes, maxQueuedMessages) => {
      const client = new AppServerClient({
        timeoutMs: 1_000,
        transportFactory: new StdioAppServerTransportFactory({
          command: process.execPath,
          args: [helperPath, mode],
          maxStdoutLineBytes,
          maxStdoutBytes,
          maxQueuedMessages,
        }),
      });

      const rejection = client.call("thread/read", {
        threadId: "transport-secret",
        includeTurns: false,
      });
      await expect(rejection).rejects.toBeInstanceOf(AppServerError);
      await expect(rejection).rejects.toThrow(expectedMessage);
      await expect(rejection).rejects.not.toThrow(/transport-secret|worker-secret|private/);
    },
  );

  test("nonzero終了を固定エラーへ変換する", async () => {
    const client = new AppServerClient({
      timeoutMs: 1_000,
      transportFactory: new StdioAppServerTransportFactory({
        command: process.execPath,
        args: [helperPath, "nonzero"],
      }),
    });

    await expect(
      client.call("thread/read", { threadId: "session-secret", includeTurns: false }),
    ).rejects.toThrow("app server process failed");
  });

  test("timeoutでPOSIX process treeを停止する", async () => {
    if (process.platform === "win32") return;
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "titlize-app-server-timeout-"));
    const pidFile = join(temporaryDirectory, "tree.json");
    const client = new AppServerClient({
      timeoutMs: 250,
      transportFactory: new StdioAppServerTransportFactory({
        command: process.execPath,
        args: [helperPath, "timeout-tree", pidFile],
      }),
    });

    try {
      await expect(
        client.call("thread/read", { threadId: "session-1", includeTurns: false }),
      ).rejects.toThrow("app server request timed out");

      const pids = await waitForTreePids(pidFile, 500);
      expect(await waitForProcessExit(pids.childPid, 1_000)).toBe(true);
      expect(await waitForProcessExit(pids.grandchildPid, 1_000)).toBe(true);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

async function waitForTreePids(
  path: string,
  timeoutMs: number,
): Promise<{ childPid: number; grandchildPid: number }> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (typeof value.childPid === "number" && typeof value.grandchildPid === "number") {
        return { childPid: value.childPid, grandchildPid: value.grandchildPid };
      }
    } catch {
      // The helper writes the file after it starts.
    }
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for helper process tree");
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(10);
  }
  return false;
}

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { loadConfig } from "../src/config";
import {
  CliError,
  composeRuntime,
  main,
  parseCliArgs,
  readHookInput,
  type CliDependencies,
  type CliRuntime,
} from "../src/cli";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const path = temporaryDirectories.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

function streamFrom(...chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

function fakeRuntime(options: {
  close?: () => void;
  handle?: CliRuntime["controller"]["handle"];
  update?: CliRuntime["service"]["update"];
} = {}): CliRuntime {
  return {
    store: { close: options.close ?? (() => undefined) },
    controller: {
      handle: options.handle ?? (async () => undefined),
    },
    service: {
      update: options.update ?? (async () => ({ status: "updated" })),
    },
  };
}

function cliHarness(options: {
  stdin?: ReadableStream<Uint8Array>;
  runtime?: CliRuntime;
  createRuntime?: CliDependencies["createRuntime"];
  stdoutFailure?: Error;
  stderrFailure?: Error;
} = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let stdinOpens = 0;
  let runtimeCreations = 0;
  const dependencies: CliDependencies = {
    openStdin() {
      stdinOpens += 1;
      return options.stdin ?? streamFrom("{}");
    },
    async writeStdout(value) {
      stdout.push(value);
      if (options.stdoutFailure) throw options.stdoutFailure;
    },
    async writeStderr(value) {
      stderr.push(value);
      if (options.stderrFailure) throw options.stderrFailure;
    },
    createRuntime(config, env, logger) {
      runtimeCreations += 1;
      return options.createRuntime
        ? options.createRuntime(config, env, logger)
        : (options.runtime ?? fakeRuntime());
    },
  };
  return {
    dependencies,
    stdout,
    stderr,
    counts: {
      get stdinOpens() {
        return stdinOpens;
      },
      get runtimeCreations() {
        return runtimeCreations;
      },
    },
  };
}

describe("parseCliArgs", () => {
  test("hook は追加引数なしだけを受け入れる", () => {
    expect(parseCliArgs(["hook"])).toEqual({ command: "hook" });
  });

  test.each([
    ["標準順", ["update", "--session-id", "session-1", "--force"]],
    ["force先頭", ["update", "--force", "--session-id", "session-1"]],
  ])("update --force を解析する: %s", (_name, args) => {
    expect(parseCliArgs(args)).toEqual({
      command: "update",
      sessionId: "session-1",
      force: true,
    });
  });

  test("任意の絶対 transcript path と flag 順序を受け入れる", () => {
    expect(
      parseCliArgs([
        "update",
        "--transcript-path",
        "/tmp/conversation.jsonl",
        "--force",
        "--session-id",
        "session-1",
      ]),
    ).toEqual({
      command: "update",
      sessionId: "session-1",
      transcriptPath: "/tmp/conversation.jsonl",
      force: true,
    });
  });

  test.each([
    ["引数なし", []],
    ["未知command", ["unknown"]],
    ["hook追加位置引数", ["hook", "extra"]],
    ["force欠落", ["update", "--session-id", "s1"]],
    ["session欠落", ["update", "--force"]],
    ["session値欠落", ["update", "--session-id", "--force"]],
    ["transcript値欠落", ["update", "--session-id", "s1", "--force", "--transcript-path"]],
    ["未知flag", ["update", "--session-id", "s1", "--force", "--other"]],
    ["余計な位置引数", ["update", "--session-id", "s1", "--force", "extra"]],
    ["session重複", ["update", "--session-id", "s1", "--session-id", "s2", "--force"]],
    ["force重複", ["update", "--session-id", "s1", "--force", "--force"]],
    ["transcript重複", ["update", "--session-id", "s1", "--force", "--transcript-path", "/a", "--transcript-path", "/b"]],
    ["空session", ["update", "--session-id", "", "--force"]],
    ["空白session", ["update", "--session-id", "   ", "--force"]],
    ["NUL session", ["update", "--session-id", "s\0secret", "--force"]],
    ["長いsession", ["update", "--session-id", "s".repeat(4097), "--force"]],
    ["相対transcript", ["update", "--session-id", "s1", "--force", "--transcript-path", "secret.jsonl"]],
    ["NUL transcript", ["update", "--session-id", "s1", "--force", "--transcript-path", "/tmp/s\0ecret"]],
    ["長いtranscript", ["update", "--session-id", "s1", "--force", "--transcript-path", `/${"p".repeat(4096)}`]],
  ])("不正な引数を固定 CliError で拒否する: %s", (_name, args) => {
    let error: unknown;
    try {
      parseCliArgs(args);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: "invalid_arguments", message: "invalid command arguments" });
    expect(String(error)).not.toContain("secret");
  });
});

describe("readHookInput", () => {
  test("分割された UTF-8 JSON を byte 単位で読み取る", async () => {
    const bytes = new TextEncoder().encode('{"message":"日本語"}');
    const input = streamFrom(bytes.subarray(0, 15), bytes.subarray(15));
    await expect(readHookInput(input)).resolves.toEqual({ message: "日本語" });
  });

  test("1 MiB を超える入力を本文非包含の固定エラーにする", async () => {
    const secret = "sensitive-hook-body";
    const input = streamFrom(`{"secret":"${secret}","padding":"${"x".repeat(1024 * 1024)}"}`);
    let error: unknown;
    try {
      await readHookInput(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: "invalid_hook_input", message: "hook input is invalid" });
    expect(String(error)).not.toContain(secret);
  });

  test("不正 JSON と不正 UTF-8 を同じ固定エラーにする", async () => {
    await expect(readHookInput(streamFrom("{secret"))).rejects.toMatchObject({
      code: "invalid_hook_input",
      message: "hook input is invalid",
    });
    await expect(readHookInput(streamFrom(new Uint8Array([0xff])))).rejects.toMatchObject({
      code: "invalid_hook_input",
      message: "hook input is invalid",
    });
  });
});

describe("main hook", () => {
  test("有効な Hook を渡し stdout へ {} 改行を一度だけ返す", async () => {
    const input = {
      hook_event_name: "Stop",
      session_id: "s1",
      turn_id: "t1",
      transcript_path: "/tmp/transcript.jsonl",
    };
    const handled: unknown[] = [];
    const h = cliHarness({
      stdin: streamFrom(JSON.stringify(input)),
      runtime: fakeRuntime({
        async handle(value) {
          handled.push(structuredClone(value));
        },
      }),
    });

    await expect(main(["hook"], {}, h.dependencies)).resolves.toBe(0);
    expect(handled).toEqual([input]);
    expect(h.stdout).toEqual(["{}\n"]);
    expect(h.stderr).toEqual([]);
  });

  test("CODEX_TITLE_CHILD=1 は stdin・設定・状態構築より前に短絡する", async () => {
    const h = cliHarness({
      stdin: streamFrom("must-not-read"),
      createRuntime() {
        throw new Error("must-not-create");
      },
    });

    await expect(
      main(
        ["hook"],
        { CODEX_TITLE_CHILD: "1", CODEX_TITLE_EVERY: "invalid" },
        h.dependencies,
      ),
    ).resolves.toBe(0);
    expect(h.counts.stdinOpens).toBe(0);
    expect(h.counts.runtimeCreations).toBe(0);
    expect(h.stdout).toEqual(["{}\n"]);
    expect(h.stderr).toEqual([]);
  });

  test.each([
    ["malformed", "{super-secret-input"],
    ["oversize", `{"secret":"oversize-secret","padding":"${"x".repeat(1024 * 1024)}"}`],
  ])("不正 stdin (%s) でも stdout 契約と exit 0 を守り安全にログする", async (_name, input) => {
    const h = cliHarness({
      stdin: streamFrom(input),
      createRuntime() {
        throw new Error("must-not-create");
      },
    });

    await expect(main(["hook"], {}, h.dependencies)).resolves.toBe(0);
    expect(h.counts.runtimeCreations).toBe(0);
    expect(h.stdout).toEqual(["{}\n"]);
    expect(h.stderr.join("")).toContain("hook_input_invalid");
    expect(h.stderr.join("")).not.toContain("secret");
  });

  test("設定不正でも状態を構築せず stdout 契約と exit 0 を守る", async () => {
    const h = cliHarness({ stdin: streamFrom("{}") });

    await expect(
      main(["hook"], { CODEX_TITLE_EVERY: "not-a-number" }, h.dependencies),
    ).resolves.toBe(0);
    expect(h.counts.runtimeCreations).toBe(0);
    expect(h.stdout).toEqual(["{}\n"]);
    expect(h.stderr).toEqual(["codex-title: hook_runtime_failed\n"]);
  });

  test("StateStore 構築失敗を本文なしの固定ログへ変換する", async () => {
    const h = cliHarness({
      stdin: streamFrom("{}"),
      createRuntime() {
        throw new Error("/private/secret/state.sqlite: api-key-123");
      },
    });

    await expect(main(["hook"], {}, h.dependencies)).resolves.toBe(0);
    expect(h.stdout).toEqual(["{}\n"]);
    expect(h.stderr).toEqual(["codex-title: hook_runtime_failed\n"]);
    expect(h.stderr.join("")).not.toContain("secret");
    expect(h.stderr.join("")).not.toContain("api-key");
  });

  test("controller 例外でも store を閉じ stdout 契約を守る", async () => {
    let closes = 0;
    const h = cliHarness({
      stdin: streamFrom("{}"),
      runtime: fakeRuntime({
        close() {
          closes += 1;
        },
        async handle() {
          throw new Error("transcript body and generated title");
        },
      }),
    });

    await expect(main(["hook"], {}, h.dependencies)).resolves.toBe(0);
    expect(closes).toBe(1);
    expect(h.stdout).toEqual(["{}\n"]);
    expect(h.stderr).toEqual(["codex-title: hook_execution_failed\n"]);
    expect(h.stderr.join("")).not.toContain("transcript");
  });

  test("controller の固定 code だけを stderr へ渡す", async () => {
    const h = cliHarness({
      stdin: streamFrom("{}"),
      createRuntime(_config, _env, logger) {
        return fakeRuntime({
          async handle() {
            logger("title_update_failed");
          },
        });
      },
    });

    await expect(main(["hook"], {}, h.dependencies)).resolves.toBe(0);
    expect(h.stdout).toEqual(["{}\n"]);
    expect(h.stderr).toEqual(["codex-title: title_update_failed\n"]);
  });

  test("store close・logger・stdout の失敗を外へ伝播させない", async () => {
    const h = cliHarness({
      stdin: streamFrom("{}"),
      stdoutFailure: new Error("closed stdout"),
      stderrFailure: new Error("closed stderr"),
      runtime: fakeRuntime({
        close() {
          throw new Error("close-secret");
        },
      }),
    });

    await expect(main(["hook"], {}, h.dependencies)).resolves.toBe(0);
    expect(h.stdout).toEqual(["{}\n"]);
    expect(h.stderr).toEqual(["codex-title: state_close_failed\n"]);
  });
});

describe("main update --force", () => {
  test("Stop 回数を増やさず force:true で更新し stdout を使わない", async () => {
    const updates: unknown[] = [];
    let closes = 0;
    const h = cliHarness({
      runtime: fakeRuntime({
        close() {
          closes += 1;
        },
        async update(input) {
          updates.push(structuredClone(input));
          return { status: "updated" };
        },
        async handle() {
          throw new Error("hook controller must not be called");
        },
      }),
    });

    await expect(
      main(["update", "--force", "--session-id", "s1"], {}, h.dependencies),
    ).resolves.toBe(0);
    expect(updates).toEqual([{ sessionId: "s1", force: true }]);
    expect(closes).toBe(1);
    expect(h.counts.stdinOpens).toBe(0);
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toEqual([]);
  });

  test("絶対 transcript path を force update へ渡す", async () => {
    const updates: unknown[] = [];
    const h = cliHarness({
      runtime: fakeRuntime({
        async update(input) {
          updates.push(structuredClone(input));
          return { status: "unchanged" };
        },
      }),
    });

    await expect(
      main(
        [
          "update",
          "--transcript-path",
          "/tmp/transcript.jsonl",
          "--session-id",
          "s1",
          "--force",
        ],
        {},
        h.dependencies,
      ),
    ).resolves.toBe(0);
    expect(updates).toEqual([{
      sessionId: "s1",
      transcriptPath: "/tmp/transcript.jsonl",
      force: true,
    }]);
    expect(h.stdout).toEqual([]);
  });

  test("service 失敗でも store を閉じ固定 stderr と非0終了にする", async () => {
    let closes = 0;
    const h = cliHarness({
      runtime: fakeRuntime({
        close() {
          closes += 1;
        },
        async update() {
          throw new Error("provider stderr: sk-secret title-body");
        },
      }),
    });

    await expect(
      main(["update", "--session-id", "s1", "--force"], {}, h.dependencies),
    ).resolves.toBe(1);
    expect(closes).toBe(1);
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toEqual(["codex-title: update_failed\n"]);
    expect(h.stderr.join("")).not.toContain("secret");
    expect(h.stderr.join("")).not.toContain("title-body");
  });

  test("構成・close 失敗も非0終了し stdout へ出さない", async () => {
    const construction = cliHarness({
      createRuntime() {
        throw new Error("state secret");
      },
    });
    await expect(
      main(["update", "--session-id", "s1", "--force"], {}, construction.dependencies),
    ).resolves.toBe(1);
    expect(construction.stdout).toEqual([]);
    expect(construction.stderr).toEqual(["codex-title: update_failed\n"]);

    const cleanup = cliHarness({
      runtime: fakeRuntime({
        close() {
          throw new Error("close secret");
        },
      }),
    });
    await expect(
      main(["update", "--session-id", "s1", "--force"], {}, cleanup.dependencies),
    ).resolves.toBe(1);
    expect(cleanup.stdout).toEqual([]);
    expect(cleanup.stderr).toEqual(["codex-title: state_close_failed\n"]);
  });

  test("CLI 引数・設定不正を安全な固定 stderr と非0終了にする", async () => {
    const badArgs = cliHarness();
    await expect(main(["update", "--force"], {}, badArgs.dependencies)).resolves.toBe(2);
    expect(badArgs.counts.runtimeCreations).toBe(0);
    expect(badArgs.stderr).toEqual(["codex-title: invalid_arguments\n"]);

    const badConfig = cliHarness();
    await expect(
      main(
        ["update", "--session-id", "s1", "--force"],
        { CODEX_TITLE_PROVIDER: "secret-provider" },
        badConfig.dependencies,
      ),
    ).resolves.toBe(1);
    expect(badConfig.counts.runtimeCreations).toBe(0);
    expect(badConfig.stderr).toEqual(["codex-title: update_failed\n"]);
    expect(badConfig.stderr.join("")).not.toContain("secret-provider");
  });
});

describe("composeRuntime", () => {
  test("設定・依存関係・ISO clock を全コンポーネントへ配線する", () => {
    const config = loadConfig({
      CODEX_TITLE_STATE_PATH: ":memory:",
      CODEX_TITLE_MODEL: "model-under-test",
      CODEX_TITLE_TIMEOUT_MS: "1234",
      CODEX_TITLE_MAX_CHARS: "31",
      CODEX_TITLE_EVERY: "5",
    });
    const environment = { CODEX_HOME: "/tmp/codex-home", API_SECRET: "must-not-be-logged" };
    const store = { close() {} };
    const reader = {};
    const provider = {};
    const client = {};
    const sink = {};
    const service = { update: async () => ({ status: "updated" as const }) };
    const controller = { handle: async () => undefined };
    const captures: Record<string, unknown> = {};

    const runtime = composeRuntime(config, environment, () => undefined, {
      createStateStore(path) {
        captures.statePath = path;
        return store as never;
      },
      createTranscriptReader() {
        return reader as never;
      },
      createProvider(options) {
        captures.provider = options;
        return provider as never;
      },
      createAppServerClient(options) {
        captures.client = options;
        return client as never;
      },
      createTitleSink(receivedClient) {
        captures.sinkClient = receivedClient;
        return sink as never;
      },
      createService(options) {
        captures.service = options;
        return service as never;
      },
      createController(options) {
        captures.controller = options;
        return controller as never;
      },
    });

    expect(runtime).toEqual({ store, service, controller });
    expect(captures.statePath).toBe(":memory:");
    expect(captures.provider).toEqual({
      model: "model-under-test",
      timeoutMs: 1234,
      baseEnv: environment,
    });
    expect(captures.client).toEqual({ timeoutMs: 1234 });
    expect(captures.sinkClient).toBe(client);
    expect(captures.service).toEqual(expect.objectContaining({
      store,
      provider,
      transcriptReader: reader,
      sink,
      maxChars: 31,
    }));
    expect(captures.controller).toEqual(expect.objectContaining({
      store,
      service,
      every: 5,
    }));
    const serviceClock = (captures.service as { clock: () => string }).clock();
    const controllerClock = (captures.controller as { clock: () => string }).clock();
    expect(serviceClock).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(controllerClock).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("StateStore 構築後の部分構成失敗でも store を閉じる", () => {
    let closes = 0;
    expect(() =>
      composeRuntime(loadConfig({ CODEX_TITLE_STATE_PATH: ":memory:" }), {}, () => undefined, {
        createStateStore() {
          return { close() { closes += 1; } } as never;
        },
        createTranscriptReader() {
          throw new Error("reader construction failed");
        },
      }),
    ).toThrow();
    expect(closes).toBe(1);
  });
});

describe("direct CLI", () => {
  test.each([
    ["Stop以外", JSON.stringify({ hook_event_name: "UserPromptSubmit" })],
    ["malformed JSON", "{malformed-secret"],
  ])("実 entrypoint も %s で stdout 契約と exit 0 を守る", async (_name, stdin) => {
    const directory = await mkdtemp(join(tmpdir(), "titlize-cli-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "state.sqlite3");
    const subprocess = Bun.spawn(["bun", "src/cli.ts", "hook"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        CODEX_TITLE_CHILD: "0",
        CODEX_TITLE_STATE_PATH: statePath,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = new Response(subprocess.stdout).text();
    const stderrPromise = new Response(subprocess.stderr).text();
    await subprocess.stdin.write(stdin);
    await subprocess.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      stdoutPromise,
      stderrPromise,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("{}\n");
    expect(stderr).not.toContain("malformed-secret");
    expect(isAbsolute(statePath)).toBe(true);
  });
});

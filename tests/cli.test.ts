import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} = {}): CliRuntime {
  return {
    store: { close: options.close ?? (() => undefined) },
    controller: {
      handle: options.handle ?? (async () => ({})),
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
    createRuntime(config, logger) {
      runtimeCreations += 1;
      return options.createRuntime
        ? options.createRuntime(config, logger)
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
  test("hookは追加引数なしだけを受け入れる", () => {
    expect(parseCliArgs(["hook"])).toEqual({ command: "hook" });
  });

  test.each([
    ["引数なし", []],
    ["未知command", ["unknown"]],
    ["追加引数", ["hook", "extra"]],
    ["旧App Server更新command", ["update", "--session-id", "s1", "--force"]],
  ])("不正な引数を固定CliErrorで拒否する: %s", (_name, args) => {
    let error: unknown;
    try {
      parseCliArgs(args);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      code: "invalid_arguments",
      message: "invalid command arguments",
    });
  });
});

describe("readHookInput", () => {
  test("分割されたUTF-8 JSONをbyte単位で読み取る", async () => {
    const bytes = new TextEncoder().encode('{"message":"日本語"}');
    await expect(
      readHookInput(streamFrom(bytes.subarray(0, 15), bytes.subarray(15))),
    ).resolves.toEqual({ message: "日本語" });
  });

  test("1 MiB超過を本文非包含の固定エラーにする", async () => {
    const secret = "sensitive-hook-body";
    const input = streamFrom(
      `{"secret":"${secret}","padding":"${"x".repeat(1024 * 1024)}"}`,
    );
    let error: unknown;
    try {
      await readHookInput(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect(String(error)).not.toContain(secret);
  });

  test("不正JSONと不正UTF-8を同じ固定エラーにする", async () => {
    await expect(readHookInput(streamFrom("{secret"))).rejects.toMatchObject({
      code: "invalid_hook_input",
    });
    await expect(readHookInput(streamFrom(new Uint8Array([0xff])))).rejects.toMatchObject({
      code: "invalid_hook_input",
    });
  });
});

describe("main hook", () => {
  test("有効なHookをcontrollerへ渡しstdoutへ{}を一度だけ返す", async () => {
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
          return {};
        },
      }),
    });

    await expect(main(["hook"], {}, h.dependencies)).resolves.toBe(0);
    expect(handled).toEqual([input]);
    expect(h.stdout).toEqual(["{}\n"]);
    expect(h.stderr).toEqual([]);
  });

  test("注入Hook出力JSONをstdoutへそのまま返す", async () => {
    const output = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit" as const,
        additionalContext: "codex_app__set_thread_titleを呼ぶ",
      },
    };
    const h = cliHarness({
      runtime: fakeRuntime({ async handle() { return output; } }),
    });

    await expect(main(["hook"], {}, h.dependencies)).resolves.toBe(0);
    expect(h.stdout).toEqual([`${JSON.stringify(output)}\n`]);
  });

  test("CODEX_TITLE_CHILD=1はstdin・設定・状態構築より前に短絡する", async () => {
    const h = cliHarness({
      stdin: streamFrom("must-not-read"),
      createRuntime() {
        throw new Error("must-not-create");
      },
    });

    await expect(
      main(["hook"], { CODEX_TITLE_CHILD: "1", CODEX_TITLE_EVERY: "invalid" }, h.dependencies),
    ).resolves.toBe(0);
    expect(h.counts.stdinOpens).toBe(0);
    expect(h.counts.runtimeCreations).toBe(0);
    expect(h.stdout).toEqual(["{}\n"]);
  });

  test.each([
    ["malformed", "{super-secret-input"],
    ["oversize", `{"secret":"oversize-secret","padding":"${"x".repeat(1024 * 1024)}"}`],
  ])("不正stdin (%s)でもstdout契約とexit 0を守る", async (_name, input) => {
    const h = cliHarness({ stdin: streamFrom(input) });

    await expect(main(["hook"], {}, h.dependencies)).resolves.toBe(0);
    expect(h.counts.runtimeCreations).toBe(0);
    expect(h.stdout).toEqual(["{}\n"]);
    expect(h.stderr).toEqual(["codex-title: hook_input_invalid\n"]);
  });

  test("設定不正でも状態を構築しない", async () => {
    const h = cliHarness();

    await expect(
      main(["hook"], { CODEX_TITLE_EVERY: "not-a-number" }, h.dependencies),
    ).resolves.toBe(0);
    expect(h.counts.runtimeCreations).toBe(0);
    expect(h.stdout).toEqual(["{}\n"]);
    expect(h.stderr).toEqual(["codex-title: hook_runtime_failed\n"]);
  });

  test("runtime構築失敗を本文なしの固定ログへ変換する", async () => {
    const h = cliHarness({
      createRuntime() {
        throw new Error("/private/secret/state.sqlite: api-key-123");
      },
    });

    await expect(main(["hook"], {}, h.dependencies)).resolves.toBe(0);
    expect(h.stdout).toEqual(["{}\n"]);
    expect(h.stderr).toEqual(["codex-title: hook_runtime_failed\n"]);
    expect(h.stderr.join("")).not.toContain("secret");
  });

  test("controller例外でもstoreを閉じstdout契約を守る", async () => {
    let closes = 0;
    const h = cliHarness({
      runtime: fakeRuntime({
        close() {
          closes += 1;
        },
        async handle() {
          throw new Error("secret conversation");
        },
      }),
    });

    await expect(main(["hook"], {}, h.dependencies)).resolves.toBe(0);
    expect(closes).toBe(1);
    expect(h.stdout).toEqual(["{}\n"]);
    expect(h.stderr).toEqual(["codex-title: hook_execution_failed\n"]);
  });

  test("controllerの固定codeだけをstderrへ渡す", async () => {
    const h = cliHarness({
      createRuntime(_config, logger) {
        return fakeRuntime({
          async handle() {
            logger("state_store_failed");
            return {};
          },
        });
      },
    });

    await expect(main(["hook"], {}, h.dependencies)).resolves.toBe(0);
    expect(h.stderr).toEqual(["codex-title: state_store_failed\n"]);
  });

  test("store close・logger・stdout失敗を外へ伝播させない", async () => {
    const h = cliHarness({
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

  test("旧update commandはApp Serverへ接続せず引数エラーにする", async () => {
    const h = cliHarness({
      createRuntime() {
        throw new Error("must-not-create");
      },
    });

    await expect(
      main(["update", "--session-id", "s1", "--force"], {}, h.dependencies),
    ).resolves.toBe(2);
    expect(h.counts.stdinOpens).toBe(0);
    expect(h.counts.runtimeCreations).toBe(0);
    expect(h.stderr).toEqual(["codex-title: invalid_arguments\n"]);
  });
});

describe("composeRuntime", () => {
  test("設定・状態・ISO clockをcontrollerへ配線する", () => {
    const config = loadConfig({
      CODEX_TITLE_STATE_PATH: ":memory:",
      CODEX_TITLE_MAX_CHARS: "31",
      CODEX_TITLE_EVERY: "5",
    });
    const store = { close() {} };
    const controller = { handle: async () => ({}) };
    const captures: Record<string, unknown> = {};

    const runtime = composeRuntime(config, () => undefined, {
      createStateStore(path) {
        captures.statePath = path;
        return store as never;
      },
      createController(options) {
        captures.controller = options;
        return controller;
      },
    });

    expect(runtime).toEqual({ store, controller });
    expect(captures.statePath).toBe(":memory:");
    expect(captures.controller).toEqual(expect.objectContaining({
      store,
      every: 5,
      maxChars: 31,
    }));
    expect(
      (captures.controller as { clock: () => string }).clock(),
    ).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("StateStore構築後のcontroller構成失敗でもstoreを閉じる", () => {
    let closes = 0;

    expect(() =>
      composeRuntime(loadConfig({ CODEX_TITLE_STATE_PATH: ":memory:" }), () => undefined, {
        createStateStore() {
          return {
            close() {
              closes += 1;
            },
          } as never;
        },
        createController() {
          throw new Error("controller-secret");
        },
      }),
    ).toThrow("controller-secret");
    expect(closes).toBe(1);
  });
});

describe("direct CLI", () => {
  test("実entrypointもStop以外でstdout契約とexit 0を守る", async () => {
    const root = await mkdtemp(join(tmpdir(), "titlize-direct-cli-"));
    temporaryDirectories.push(root);
    const statePath = join(root, "state.sqlite3");
    const child = Bun.spawn(["bun", "src/cli.ts", "hook"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CODEX_TITLE_STATE_PATH: statePath },
      stdin: new Blob([JSON.stringify({ hook_event_name: "SessionStart" })]),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("{}\n");
    expect(stderr).toBe("");
  });
});

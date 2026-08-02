import { loadConfig } from "./config";
import {
  HookController,
  type HookControllerOptions,
  type HookLogCode,
  type HookOutput,
  type HookStateStore,
} from "./hook-controller";
import { StateStore } from "./state-store";
import type { TitleConfig } from "./types";

export const MAX_HOOK_INPUT_BYTES = 1024 * 1024;

export type CliErrorCode = "invalid_arguments" | "invalid_hook_input";

const CLI_ERROR_MESSAGES: Record<CliErrorCode, string> = {
  invalid_arguments: "invalid command arguments",
  invalid_hook_input: "hook input is invalid",
};

export class CliError extends Error {
  private constructor(readonly code: CliErrorCode) {
    super(CLI_ERROR_MESSAGES[code]);
    this.name = "CliError";
  }

  static for(code: CliErrorCode): CliError {
    return new CliError(code);
  }
}

export type CliCommand = { command: "hook" };

export function parseCliArgs(args: readonly string[]): CliCommand {
  if (args.length === 1 && args[0] === "hook") return { command: "hook" };
  throw CliError.for("invalid_arguments");
}

export async function readHookInput(
  input: ReadableStream<Uint8Array>,
  maxBytes = MAX_HOOK_INPUT_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw CliError.for("invalid_hook_input");
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = input.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error();
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error();
      }
      if (value.byteLength > 0) chunks.push(value);
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw CliError.for("invalid_hook_input");
  } finally {
    try {
      reader?.releaseLock();
    } catch {
      // Invalid or hostile input must not replace the fixed CLI error.
    }
  }
}

export interface CliStateStore extends HookStateStore {
  close(): void;
}

export interface CliRuntime {
  store: { close(): void };
  controller: {
    handle(
      input: unknown,
      env?: Readonly<Record<string, string | undefined>>,
    ): Promise<HookOutput>;
  };
}

export interface RuntimeFactories {
  createStateStore(path: string): CliStateStore;
  createController(options: HookControllerOptions): CliRuntime["controller"];
}

const DEFAULT_RUNTIME_FACTORIES: RuntimeFactories = {
  createStateStore: (path) => new StateStore(path),
  createController: (options) => new HookController(options),
};

export function composeRuntime(
  config: TitleConfig,
  logger: (code: HookLogCode) => void,
  overrides: Partial<RuntimeFactories> = {},
): CliRuntime {
  const factories = { ...DEFAULT_RUNTIME_FACTORIES, ...overrides };
  let store: CliStateStore | undefined;
  try {
    store = factories.createStateStore(config.statePath);
    const controller = factories.createController({
      store,
      every: config.every,
      maxChars: config.maxChars,
      clock: (): string => new Date().toISOString(),
      logger,
    });
    return { store, controller };
  } catch (error) {
    try {
      store?.close();
    } catch {
      // Preserve the construction failure while still attempting cleanup.
    }
    throw error;
  }
}

export interface CliDependencies {
  openStdin?: () => ReadableStream<Uint8Array>;
  writeStdout?: (value: string) => void | Promise<void>;
  writeStderr?: (value: string) => void | Promise<void>;
  createRuntime?: (
    config: TitleConfig,
    logger: (code: HookLogCode) => void,
  ) => CliRuntime;
}

interface ResolvedCliDependencies {
  openStdin: () => ReadableStream<Uint8Array>;
  writeStdout: (value: string) => void | Promise<void>;
  writeStderr: (value: string) => void | Promise<void>;
  createRuntime: NonNullable<CliDependencies["createRuntime"]>;
}

type CliLogCode =
  | HookLogCode
  | "invalid_arguments"
  | "hook_input_invalid"
  | "hook_runtime_failed"
  | "hook_execution_failed"
  | "state_close_failed";

const CLI_LOG_LINES: Record<CliLogCode, string> = {
  invalid_stop_input: "codex-title: invalid_stop_input\n",
  invalid_prompt_input: "codex-title: invalid_prompt_input\n",
  invalid_tool_input: "codex-title: invalid_tool_input\n",
  title_read_failed: "codex-title: title_read_failed\n",
  state_store_failed: "codex-title: state_store_failed\n",
  invalid_arguments: "codex-title: invalid_arguments\n",
  hook_input_invalid: "codex-title: hook_input_invalid\n",
  hook_runtime_failed: "codex-title: hook_runtime_failed\n",
  hook_execution_failed: "codex-title: hook_execution_failed\n",
  state_close_failed: "codex-title: state_close_failed\n",
};

export async function main(
  args: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  dependencies: CliDependencies = {},
): Promise<number> {
  const resolved = resolveDependencies(dependencies);
  try {
    parseCliArgs(args);
  } catch {
    await safeWriteLog(resolved.writeStderr, "invalid_arguments");
    return 2;
  }
  return runHookCommand(env, resolved);
}

async function runHookCommand(
  env: Record<string, string | undefined>,
  dependencies: ResolvedCliDependencies,
): Promise<number> {
  const pendingLogs: Promise<void>[] = [];
  const queueLog = (code: HookLogCode): void => {
    pendingLogs.push(safeWriteLog(dependencies.writeStderr, code));
  };
  let runtime: CliRuntime | undefined;
  let hookOutput: HookOutput = {};

  try {
    if (env.CODEX_TITLE_CHILD === "1") return 0;

    let input: unknown;
    try {
      input = await readHookInput(dependencies.openStdin());
    } catch {
      pendingLogs.push(safeWriteLog(dependencies.writeStderr, "hook_input_invalid"));
      return 0;
    }

    let config: TitleConfig;
    try {
      config = loadConfig(env);
      runtime = dependencies.createRuntime(config, queueLog);
    } catch {
      pendingLogs.push(safeWriteLog(dependencies.writeStderr, "hook_runtime_failed"));
      return 0;
    }

    try {
      hookOutput = await runtime.controller.handle(input, env);
    } catch {
      pendingLogs.push(safeWriteLog(dependencies.writeStderr, "hook_execution_failed"));
    }
    return 0;
  } finally {
    if (runtime !== undefined) {
      try {
        runtime.store.close();
      } catch {
        pendingLogs.push(safeWriteLog(dependencies.writeStderr, "state_close_failed"));
      }
    }
    await Promise.all(pendingLogs);
    await safeWrite(dependencies.writeStdout, `${JSON.stringify(hookOutput)}\n`);
  }
}

function resolveDependencies(dependencies: CliDependencies): ResolvedCliDependencies {
  return {
    openStdin: dependencies.openStdin ?? (() => Bun.stdin.stream()),
    writeStdout: dependencies.writeStdout ?? (async (value) => {
      await Bun.stdout.write(value);
    }),
    writeStderr: dependencies.writeStderr ?? (async (value) => {
      await Bun.stderr.write(value);
    }),
    createRuntime:
      dependencies.createRuntime ??
      ((config, logger) => composeRuntime(config, logger)),
  };
}

async function safeWriteLog(
  write: (value: string) => void | Promise<void>,
  code: CliLogCode,
): Promise<void> {
  await safeWrite(write, CLI_LOG_LINES[code]);
}

async function safeWrite(
  write: (value: string) => void | Promise<void>,
  value: string,
): Promise<void> {
  try {
    await Promise.resolve().then(() => write(value));
  } catch {
    // Hook output/log failures cannot be repaired safely without risking duplicates.
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}

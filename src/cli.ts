import { isAbsolute } from "node:path";
import {
  AppServerClient,
  type AppServerRpcClient,
} from "./app-server-client";
import { AppServerTitleSink } from "./app-server-title-sink";
import { CodexTitleProvider } from "./codex-title-provider";
import { loadConfig } from "./config";
import {
  HookController,
  type HookControllerOptions,
  type HookLogCode,
  type HookStateStore,
  type HookTitleUpdateService,
} from "./hook-controller";
import { StateStore } from "./state-store";
import {
  TitleUpdateService,
  type TitleUpdateRequest,
  type TitleUpdateResult,
  type TitleUpdateServiceOptions,
  type TitleUpdateSink,
  type TitleUpdateStateStore,
  type TitleUpdateTranscriptReader,
} from "./title-update-service";
import { TranscriptReader } from "./transcript-reader";
import type { TitleConfig, TitleProvider } from "./types";

const MAX_ID_CODE_UNITS = 4_096;
const MAX_TRANSCRIPT_PATH_CODE_UNITS = 4_096;
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

export type CliCommand =
  | { command: "hook" }
  | {
      command: "update";
      sessionId: string;
      transcriptPath?: string;
      force: true;
    };

export function parseCliArgs(args: readonly string[]): CliCommand {
  try {
    if (args.length === 1 && args[0] === "hook") return { command: "hook" };
    if (args[0] !== "update") throw new Error();

    let sessionId: string | undefined;
    let transcriptPath: string | undefined;
    let force = false;
    const seen = new Set<string>();

    for (let index = 1; index < args.length; index += 1) {
      const flag = args[index];
      if (flag !== "--session-id" && flag !== "--transcript-path" && flag !== "--force") {
        throw new Error();
      }
      if (seen.has(flag)) throw new Error();
      seen.add(flag);

      if (flag === "--force") {
        force = true;
        continue;
      }

      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error();
      index += 1;
      if (flag === "--session-id") sessionId = value;
      else transcriptPath = value;
    }

    if (!force || !isBoundedId(sessionId)) throw new Error();
    if (
      transcriptPath !== undefined &&
      (!isBoundedString(transcriptPath, MAX_TRANSCRIPT_PATH_CODE_UNITS) ||
        !isAbsolute(transcriptPath))
    ) {
      throw new Error();
    }

    return transcriptPath === undefined
      ? { command: "update", sessionId, force: true }
      : { command: "update", sessionId, transcriptPath, force: true };
  } catch {
    throw CliError.for("invalid_arguments");
  }
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

export interface CliStateStore extends HookStateStore, TitleUpdateStateStore {
  close(): void;
}

export interface CliRuntime {
  store: { close(): void };
  controller: {
    handle(
      input: unknown,
      env?: Readonly<Record<string, string | undefined>>,
    ): Promise<void>;
  };
  service: {
    update(input: TitleUpdateRequest): Promise<TitleUpdateResult>;
  };
}

export interface RuntimeFactories {
  createStateStore(path: string): CliStateStore;
  createTranscriptReader(): TitleUpdateTranscriptReader;
  createProvider(options: {
    model: string;
    timeoutMs: number;
    baseEnv: Record<string, string | undefined>;
  }): TitleProvider;
  createAppServerClient(options: { timeoutMs: number }): AppServerRpcClient;
  createTitleSink(client: AppServerRpcClient): TitleUpdateSink;
  createService(options: TitleUpdateServiceOptions): HookTitleUpdateService & {
    update(input: TitleUpdateRequest): Promise<TitleUpdateResult>;
  };
  createController(options: HookControllerOptions): {
    handle(
      input: unknown,
      env?: Readonly<Record<string, string | undefined>>,
    ): Promise<void>;
  };
}

const DEFAULT_RUNTIME_FACTORIES: RuntimeFactories = {
  createStateStore: (path) => new StateStore(path),
  createTranscriptReader: () => new TranscriptReader(),
  createProvider: (options) => new CodexTitleProvider(options),
  createAppServerClient: (options) => new AppServerClient(options),
  createTitleSink: (client) => new AppServerTitleSink(client),
  createService: (options) => new TitleUpdateService(options),
  createController: (options) => new HookController(options),
};

export function composeRuntime(
  config: TitleConfig,
  env: Record<string, string | undefined>,
  logger: (code: HookLogCode) => void,
  overrides: Partial<RuntimeFactories> = {},
): CliRuntime {
  const factories = { ...DEFAULT_RUNTIME_FACTORIES, ...overrides };
  let store: CliStateStore | undefined;
  try {
    store = factories.createStateStore(config.statePath);
    const transcriptReader = factories.createTranscriptReader();
    const provider = factories.createProvider({
      model: config.model,
      timeoutMs: config.timeoutMs,
      baseEnv: env,
    });
    const client = factories.createAppServerClient({ timeoutMs: config.timeoutMs });
    const sink = factories.createTitleSink(client);
    const clock = (): string => new Date().toISOString();
    const service = factories.createService({
      store,
      provider,
      transcriptReader,
      sink,
      maxChars: config.maxChars,
      clock,
    });
    const controller = factories.createController({
      store,
      service,
      every: config.every,
      clock,
      logger,
    });
    return { store, service, controller };
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
    env: Record<string, string | undefined>,
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
  | "state_close_failed"
  | "update_failed";

const CLI_LOG_LINES: Record<CliLogCode, string> = {
  invalid_stop_input: "codex-title: invalid_stop_input\n",
  state_store_failed: "codex-title: state_store_failed\n",
  title_update_failed: "codex-title: title_update_failed\n",
  invalid_arguments: "codex-title: invalid_arguments\n",
  hook_input_invalid: "codex-title: hook_input_invalid\n",
  hook_runtime_failed: "codex-title: hook_runtime_failed\n",
  hook_execution_failed: "codex-title: hook_execution_failed\n",
  state_close_failed: "codex-title: state_close_failed\n",
  update_failed: "codex-title: update_failed\n",
};

export async function main(
  args: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  dependencies: CliDependencies = {},
): Promise<number> {
  const resolved = resolveDependencies(dependencies);
  let command: CliCommand;
  try {
    command = parseCliArgs(args);
  } catch {
    await safeWriteLog(resolved.writeStderr, "invalid_arguments");
    return 2;
  }

  return command.command === "hook"
    ? runHookCommand(env, resolved)
    : runUpdateCommand(command, env, resolved);
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
      runtime = dependencies.createRuntime(config, env, queueLog);
    } catch {
      pendingLogs.push(safeWriteLog(dependencies.writeStderr, "hook_runtime_failed"));
      return 0;
    }

    try {
      await runtime.controller.handle(input, env);
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
    await safeWrite(dependencies.writeStdout, "{}\n");
  }
}

async function runUpdateCommand(
  command: Extract<CliCommand, { command: "update" }>,
  env: Record<string, string | undefined>,
  dependencies: ResolvedCliDependencies,
): Promise<number> {
  const pendingLogs: Promise<void>[] = [];
  const queueLog = (code: HookLogCode): void => {
    pendingLogs.push(safeWriteLog(dependencies.writeStderr, code));
  };
  let runtime: CliRuntime | undefined;
  let exitCode = 0;

  try {
    const config = loadConfig(env);
    runtime = dependencies.createRuntime(config, env, queueLog);
    await runtime.service.update({
      sessionId: command.sessionId,
      ...(command.transcriptPath === undefined
        ? {}
        : { transcriptPath: command.transcriptPath }),
      force: true,
    });
  } catch {
    exitCode = 1;
    pendingLogs.push(safeWriteLog(dependencies.writeStderr, "update_failed"));
  } finally {
    if (runtime !== undefined) {
      try {
        runtime.store.close();
      } catch {
        exitCode = 1;
        pendingLogs.push(safeWriteLog(dependencies.writeStderr, "state_close_failed"));
      }
    }
    await Promise.all(pendingLogs);
  }
  return exitCode;
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
      ((config, env, logger) => composeRuntime(config, env, logger)),
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

function isBoundedId(value: unknown): value is string {
  return isBoundedString(value, MAX_ID_CODE_UNITS) && value.trim().length > 0;
}

function isBoundedString(value: unknown, maxCodeUnits: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxCodeUnits &&
    !value.includes("\0")
  );
}

if (import.meta.main) {
  process.exitCode = await main();
}

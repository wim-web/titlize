import { createProcessTreeKiller } from "./codex-title-provider";

const CLIENT_VERSION = "0.1.0";
const MAX_THREAD_ID_CODE_UNITS = 4_096;
const MAX_TITLE_CODE_UNITS = 4_096;
const MAX_REQUEST_BYTES = 32 * 1024;
const DEFAULT_MAX_STDOUT_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_MESSAGES = 256;
const MAX_CONFIGURED_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_CONFIGURED_QUEUE_MESSAGES = 4_096;
const CLEANUP_GRACE_MS = 100;
const CLIENT_CLEANUP_GRACE_MS = 200;

type AppServerErrorReason =
  | "invalidRequest"
  | "startFailed"
  | "timedOut"
  | "protocolError"
  | "rpcError"
  | "processFailed"
  | "outputTooLarge";

export class AppServerError extends Error {
  private constructor(reason: AppServerErrorReason) {
    super(
      {
        invalidRequest: "app server request is invalid",
        startFailed: "app server could not start",
        timedOut: "app server request timed out",
        protocolError: "app server returned an invalid response",
        rpcError: "app server request failed",
        processFailed: "app server process failed",
        outputTooLarge: "app server output exceeded the safety limit",
      }[reason],
    );
    this.name = "AppServerError";
  }

  static invalidRequest(): AppServerError {
    return new AppServerError("invalidRequest");
  }

  static startFailed(): AppServerError {
    return new AppServerError("startFailed");
  }

  static timedOut(): AppServerError {
    return new AppServerError("timedOut");
  }

  static protocolError(): AppServerError {
    return new AppServerError("protocolError");
  }

  static rpcError(): AppServerError {
    return new AppServerError("rpcError");
  }

  static processFailed(): AppServerError {
    return new AppServerError("processFailed");
  }

  static outputTooLarge(): AppServerError {
    return new AppServerError("outputTooLarge");
  }
}

export type AppServerRpcMethod = "thread/read" | "thread/name/set";

export interface AppServerRpcClient {
  call(method: AppServerRpcMethod, params: unknown): Promise<unknown>;
}

export interface TransportOpenOptions {
  signal: AbortSignal;
}

export interface AppServerTransport {
  writeLine(line: string): Promise<void>;
  readMessage(): Promise<unknown>;
  close(): Promise<void>;
}

export interface AppServerTransportFactory {
  open(options: TransportOpenOptions): Promise<AppServerTransport>;
}

export interface AppServerClientOptions {
  timeoutMs: number;
  transportFactory?: AppServerTransportFactory;
}

export class AppServerClient implements AppServerRpcClient {
  private readonly timeoutMs: number;
  private readonly transportFactory: AppServerTransportFactory;

  constructor(options: AppServerClientOptions) {
    if (!isPositiveSafeTimeout(options.timeoutMs)) throw AppServerError.invalidRequest();
    this.timeoutMs = options.timeoutMs;
    this.transportFactory = options.transportFactory ?? new StdioAppServerTransportFactory();
  }

  async call(method: AppServerRpcMethod, params: unknown): Promise<unknown> {
    let lines: { initialize: string; initialized: string; request: string };
    try {
      const validated = validateRpcCall(method, params);
      lines = {
        initialize: serializeRequest({
          method: "initialize",
          id: 1,
          params: {
            clientInfo: { name: "titlize", version: CLIENT_VERSION },
            capabilities: { experimentalApi: false },
          },
        }),
        initialized: serializeRequest({ method: "initialized" }),
        request: serializeRequest({ method: validated.method, id: 2, params: validated.params }),
      };
    } catch {
      throw AppServerError.invalidRequest();
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    let transport: AppServerTransport | undefined;
    let result: unknown;
    let failure: AppServerError | undefined;
    let opened = false;

    try {
      transport = await raceWithSignal(
        this.transportFactory.open({ signal: controller.signal }),
        controller.signal,
      );
      opened = true;
      await raceWithSignal(transport.writeLine(lines.initialize), controller.signal);
      const initializeResponse = await waitForResponse(transport, 1, controller.signal);
      validateInitializeResult(initializeResponse);

      await raceWithSignal(transport.writeLine(lines.initialized), controller.signal);
      await raceWithSignal(transport.writeLine(lines.request), controller.signal);
      result = await waitForResponse(transport, 2, controller.signal);
    } catch (error) {
      failure = normalizeClientError(error, timedOut, opened);
    }

    if (transport) {
      const closeError = await closeBeforeReturn(transport, controller.signal);
      if (closeError) failure ??= normalizeClientError(closeError, timedOut, true);
    }

    clearTimeout(timeout);
    if (!controller.signal.aborted) controller.abort();
    if (timedOut) throw AppServerError.timedOut();
    if (failure) throw failure;
    return result;
  }
}

interface ValidatedRpcCall {
  method: AppServerRpcMethod;
  params: Record<string, string | boolean>;
}

function validateRpcCall(method: unknown, params: unknown): ValidatedRpcCall {
  if (!isPlainRecord(params)) throw AppServerError.invalidRequest();

  if (method === "thread/read") {
    if (!hasExactlyKeys(params, ["threadId", "includeTurns"])) {
      throw AppServerError.invalidRequest();
    }
    const threadId = validateThreadId(params.threadId);
    if (typeof params.includeTurns !== "boolean") throw AppServerError.invalidRequest();
    return { method, params: { threadId, includeTurns: params.includeTurns } };
  }

  if (method === "thread/name/set") {
    if (!hasExactlyKeys(params, ["threadId", "name"])) throw AppServerError.invalidRequest();
    const threadId = validateThreadId(params.threadId);
    const name = validateTitle(params.name);
    return { method, params: { threadId, name } };
  }

  throw AppServerError.invalidRequest();
}

export function validateThreadId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_THREAD_ID_CODE_UNITS ||
    value.includes("\0")
  ) {
    throw AppServerError.invalidRequest();
  }
  return value;
}

export function validateAppServerTitle(value: unknown): string {
  return validateTitle(value);
}

function validateTitle(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TITLE_CODE_UNITS ||
    value.includes("\0")
  ) {
    throw AppServerError.invalidRequest();
  }
  return value;
}

function serializeRequest(value: unknown): string {
  const line = JSON.stringify(value);
  if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) {
    throw AppServerError.invalidRequest();
  }
  return line;
}

async function waitForResponse(
  transport: AppServerTransport,
  id: 1 | 2,
  signal: AbortSignal,
): Promise<unknown> {
  while (true) {
    const message = await raceWithSignal(transport.readMessage(), signal);
    if (!isPlainRecord(message)) throw AppServerError.protocolError();

    // Notifications and server-originated requests are unrelated to this short-lived call.
    if (typeof message.method === "string") continue;
    if (message.id !== id) continue;

    if (Object.hasOwn(message, "error")) throw AppServerError.rpcError();
    if (!Object.hasOwn(message, "result")) throw AppServerError.protocolError();
    return message.result;
  }
}

function validateInitializeResult(value: unknown): void {
  if (!isPlainRecord(value)) throw AppServerError.protocolError();
  for (const key of ["userAgent", "codexHome", "platformFamily", "platformOs"] as const) {
    if (typeof value[key] !== "string") throw AppServerError.protocolError();
  }
}

function normalizeClientError(
  error: unknown,
  timedOut: boolean,
  opened: boolean,
): AppServerError {
  if (timedOut) return AppServerError.timedOut();
  if (error instanceof AppServerError) return error;
  return opened ? AppServerError.processFailed() : AppServerError.startFailed();
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The operation was already started while evaluating the argument. Observe its eventual
    // rejection even though the caller must receive the timeout immediately.
    void promise.catch(() => {});
    return Promise.reject(AppServerError.timedOut());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(AppServerError.timedOut());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

type CloseOutcome = { status: "closed" } | { status: "failed"; error: unknown };
const CLOSE_ABORTED = Symbol("close-aborted");
const CLOSE_DEADLINE = Symbol("close-deadline");

async function closeBeforeReturn(
  transport: AppServerTransport,
  signal: AbortSignal,
): Promise<unknown | undefined> {
  const closeOutcome: Promise<CloseOutcome> = Promise.resolve()
    .then(() => transport.close())
    .then(
      () => ({ status: "closed" as const }),
      (error: unknown) => ({ status: "failed" as const, error }),
    );

  let outcome: CloseOutcome | typeof CLOSE_ABORTED;
  if (signal.aborted) {
    outcome = CLOSE_ABORTED;
  } else {
    outcome = await Promise.race([closeOutcome, resolveOnAbort(signal)]);
  }

  if (outcome === CLOSE_ABORTED) {
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanupDeadline = new Promise<typeof CLOSE_DEADLINE>((resolve) => {
      cleanupTimer = setTimeout(() => resolve(CLOSE_DEADLINE), CLIENT_CLEANUP_GRACE_MS);
    });
    const cleanupOutcome = await Promise.race([closeOutcome, cleanupDeadline]);
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    if (cleanupOutcome === CLOSE_DEADLINE) return AppServerError.processFailed();
    outcome = cleanupOutcome;
  }

  return outcome.status === "failed" ? outcome.error : undefined;
}

function resolveOnAbort(signal: AbortSignal): Promise<typeof CLOSE_ABORTED> {
  if (signal.aborted) return Promise.resolve(CLOSE_ABORTED);
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(CLOSE_ABORTED), { once: true });
  });
}

function isPositiveSafeTimeout(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 2_147_483_647
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export interface StdioAppServerTransportFactoryOptions {
  command?: string;
  args?: readonly string[];
  maxStdoutLineBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxQueuedMessages?: number;
}

interface StdioLimits {
  maxStdoutLineBytes: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxQueuedMessages: number;
}

export class StdioAppServerTransportFactory implements AppServerTransportFactory {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly limits: StdioLimits;

  constructor(options: StdioAppServerTransportFactoryOptions = {}) {
    this.command = options.command ?? "codex";
    this.args = options.args ? [...options.args] : ["app-server", "--listen", "stdio://"];
    this.limits = {
      maxStdoutLineBytes: options.maxStdoutLineBytes ?? DEFAULT_MAX_STDOUT_LINE_BYTES,
      maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
      maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
      maxQueuedMessages: options.maxQueuedMessages ?? DEFAULT_MAX_QUEUED_MESSAGES,
    };
  }

  async open(options: TransportOpenOptions): Promise<AppServerTransport> {
    try {
      validateSpawnConfiguration(this.command, this.args, this.limits);
      if (options.signal.aborted) throw AppServerError.timedOut();
      const subprocess = Bun.spawn([this.command, ...this.args], {
        detached: true,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const transport = new StdioAppServerTransport(subprocess, options.signal, this.limits);
      if (options.signal.aborted) {
        await transport.close();
        throw AppServerError.timedOut();
      }
      return transport;
    } catch (error) {
      if (error instanceof AppServerError) throw error;
      throw AppServerError.startFailed();
    }
  }
}

interface MessageWaiter {
  resolve(value: unknown): void;
  reject(error: AppServerError): void;
}

class StdioAppServerTransport implements AppServerTransport {
  private readonly queue: unknown[] = [];
  private waiter: MessageWaiter | undefined;
  private terminalError: AppServerError | undefined;
  private closing = false;
  private closed = false;
  private readonly killProcessTree: () => void;
  private readonly stdoutReader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly stderrReader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly stdoutTask: Promise<void>;
  private readonly stderrTask: Promise<void>;
  private readonly exitTask: Promise<number>;

  private readonly onAbort = (): void => {
    this.fail(AppServerError.timedOut());
  };

  constructor(
    private readonly subprocess: Bun.PipedSubprocess,
    private readonly signal: AbortSignal,
    private readonly limits: StdioLimits,
  ) {
    this.killProcessTree = createProcessTreeKiller({
      pid: subprocess.pid,
      directKill: () => subprocess.kill("SIGKILL"),
    });
    this.stdoutReader = subprocess.stdout.getReader();
    this.stderrReader = subprocess.stderr.getReader();
    this.signal.addEventListener("abort", this.onAbort, { once: true });

    this.exitTask = subprocess.exited.then(
      (exitCode) => {
        if (!this.closing && exitCode !== 0) this.fail(AppServerError.processFailed());
        return exitCode;
      },
      () => {
        this.fail(AppServerError.processFailed());
        return -1;
      },
    );
    this.stdoutTask = this.pumpStdout().catch((error: unknown) => {
      this.fail(error instanceof AppServerError ? error : AppServerError.protocolError());
    });
    this.stderrTask = this.drainStderr().catch((error: unknown) => {
      this.fail(error instanceof AppServerError ? error : AppServerError.processFailed());
    });
  }

  async writeLine(line: string): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    if (this.closing || Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES || line.includes("\n")) {
      throw AppServerError.invalidRequest();
    }
    try {
      await this.subprocess.stdin.write(`${line}\n`);
      await this.subprocess.stdin.flush();
    } catch {
      throw this.terminalError ?? AppServerError.processFailed();
    }
    if (this.terminalError) throw this.terminalError;
  }

  async readMessage(): Promise<unknown> {
    if (this.terminalError) throw this.terminalError;
    if (this.queue.length > 0) return this.queue.shift();
    if (this.waiter) throw AppServerError.protocolError();
    return await new Promise<unknown>((resolve, reject) => {
      this.waiter = { resolve, reject };
      if (this.terminalError) {
        this.waiter = undefined;
        reject(this.terminalError);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    let endPromise: Promise<unknown> = Promise.resolve();

    try {
      endPromise = Promise.resolve().then(() => this.subprocess.stdin.end());
      try {
        if (this.signal.aborted) void endPromise.catch(() => {});
        else await raceWithSignal(endPromise, this.signal);
      } catch {
        // The process may already have closed its input pipe.
      }

      if (!this.signal.aborted) {
        await raceWithSignal(this.exitTask, this.signal);
      }
    } finally {
      if (this.subprocess.exitCode === null) this.killProcessTree();
      this.cancelReaders();
      await waitForCleanup([endPromise, this.stdoutTask, this.stderrTask, this.exitTask]);
      this.signal.removeEventListener("abort", this.onAbort);
      this.closed = true;
    }

    if (this.signal.aborted) throw AppServerError.timedOut();
    if (this.terminalError) throw this.terminalError;
    if (this.subprocess.exitCode !== 0) throw AppServerError.processFailed();
  }

  private async pumpStdout(): Promise<void> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let totalBytes = 0;
    const lineParts: Uint8Array<ArrayBufferLike>[] = [];
    let lineBytes = 0;

    const appendLinePart = (part: Uint8Array<ArrayBufferLike>): void => {
      lineBytes += part.byteLength;
      // One trailing carriage return may be removed when LF completes the line.
      if (lineBytes > this.limits.maxStdoutLineBytes + 1) {
        throw AppServerError.outputTooLarge();
      }
      if (part.byteLength > 0) lineParts.push(part);
    };
    const takeLine = (): Uint8Array<ArrayBufferLike> => {
      const line = new Uint8Array(lineBytes);
      let offset = 0;
      for (const part of lineParts) {
        line.set(part, offset);
        offset += part.byteLength;
      }
      lineParts.length = 0;
      lineBytes = 0;
      return line;
    };

    try {
      while (true) {
        const { done, value } = await this.stdoutReader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > this.limits.maxStdoutBytes) throw AppServerError.outputTooLarge();
        let start = 0;
        for (let index = 0; index < value.byteLength; index += 1) {
          if (value[index] !== 0x0a) continue;
          appendLinePart(value.subarray(start, index));
          this.acceptLine(takeLine(), decoder);
          start = index + 1;
        }
        if (start < value.byteLength) appendLinePart(value.subarray(start));
      }

      if (lineBytes > 0) this.acceptLine(takeLine(), decoder);
      if (!this.closing && !this.terminalError) {
        const exitCode = await this.exitTask;
        this.fail(exitCode === 0 ? AppServerError.protocolError() : AppServerError.processFailed());
      }
    } finally {
      this.stdoutReader.releaseLock();
    }
  }

  private acceptLine(bytes: Uint8Array<ArrayBufferLike>, decoder: TextDecoder): void {
    const withoutCarriageReturn =
      bytes.at(-1) === 0x0d ? bytes.subarray(0, bytes.byteLength - 1) : bytes;
    if (withoutCarriageReturn.byteLength === 0) throw AppServerError.protocolError();
    if (withoutCarriageReturn.byteLength > this.limits.maxStdoutLineBytes) {
      throw AppServerError.outputTooLarge();
    }

    let message: unknown;
    try {
      message = JSON.parse(decoder.decode(withoutCarriageReturn)) as unknown;
    } catch {
      throw AppServerError.protocolError();
    }
    this.pushMessage(message);
  }

  private async drainStderr(): Promise<void> {
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await this.stderrReader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > this.limits.maxStderrBytes) throw AppServerError.outputTooLarge();
      }
    } finally {
      this.stderrReader.releaseLock();
    }
  }

  private pushMessage(message: unknown): void {
    if (this.terminalError || this.closing) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve(message);
      return;
    }
    if (this.queue.length >= this.limits.maxQueuedMessages) {
      throw AppServerError.outputTooLarge();
    }
    this.queue.push(message);
  }

  private fail(error: AppServerError): void {
    if (this.terminalError) return;
    this.terminalError = error;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(error);
    this.killProcessTree();
    try {
      const endResult = this.subprocess.stdin.end();
      void Promise.resolve(endResult).catch(() => {});
    } catch {
      // The input pipe may already be closed.
    }
    this.cancelReaders();
  }

  private cancelReaders(): void {
    void this.stdoutReader.cancel().catch(() => {});
    void this.stderrReader.cancel().catch(() => {});
  }
}

async function waitForCleanup(promises: readonly Promise<unknown>[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CLEANUP_GRACE_MS);
  });
  await Promise.race([Promise.allSettled(promises).then(() => {}), deadline]);
  if (timer !== undefined) clearTimeout(timer);
}

function validateSpawnConfiguration(
  command: unknown,
  args: readonly string[],
  limits: StdioLimits,
): void {
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    command.length > 4_096 ||
    command.includes("\0") ||
    !Array.isArray(args) ||
    args.length > 64 ||
    !args.every(
      (argument) =>
        typeof argument === "string" && argument.length <= 4_096 && !argument.includes("\0"),
    ) ||
    !isBoundedPositiveInteger(limits.maxStdoutLineBytes, MAX_CONFIGURED_OUTPUT_BYTES) ||
    !isBoundedPositiveInteger(limits.maxStdoutBytes, MAX_CONFIGURED_OUTPUT_BYTES) ||
    limits.maxStdoutLineBytes > limits.maxStdoutBytes ||
    !isBoundedPositiveInteger(limits.maxStderrBytes, MAX_CONFIGURED_OUTPUT_BYTES) ||
    !isBoundedPositiveInteger(limits.maxQueuedMessages, MAX_CONFIGURED_QUEUE_MESSAGES)
  ) {
    throw AppServerError.invalidRequest();
  }
}

function isBoundedPositiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

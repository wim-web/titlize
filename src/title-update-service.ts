import { isAbsolute } from "node:path";
import { validateTitle } from "./title-validator";
import type {
  NormalizedMessage,
  SessionState,
  TitleProvider,
  TitleProviderInput,
} from "./types";

const MAX_SESSION_ID_CODE_UNITS = 4_096;
const MAX_TRANSCRIPT_PATH_CODE_UNITS = 4_096;

export interface TitleUpdateRequest {
  sessionId: string;
  transcriptPath?: string;
  force: boolean;
}

export type TitleUpdateResult = {
  status: "updated" | "unchanged" | "manual-change" | "disabled";
};

export interface TitleUpdateStateStore {
  getSession(sessionId: string): SessionState | undefined;
  markPending(sessionId: string, now: string): SessionState;
  markTitleWritePending(sessionId: string, title: string, now: string): SessionState;
  clearTitleWritePending(sessionId: string, now: string): SessionState;
  markSuccess(sessionId: string, title: string, now: string): SessionState;
  markForcedSuccess(sessionId: string, title: string, now: string): SessionState;
  markAutoUpdateDisabled(sessionId: string, now: string): SessionState;
}

export interface TitleUpdateTranscriptReader {
  read(path: string): Promise<NormalizedMessage[]>;
}

export interface TitleUpdateSink {
  readTitle(sessionId: string): Promise<string | undefined>;
  readConversation(sessionId: string): Promise<NormalizedMessage[]>;
  setTitle(sessionId: string, title: string): Promise<void>;
}

export type TitleUpdateErrorCode =
  | "invalid_request"
  | "state_failed"
  | "title_read_failed"
  | "conversation_read_failed"
  | "generation_failed"
  | "validation_failed"
  | "title_write_failed";

const ERROR_MESSAGES: Record<TitleUpdateErrorCode, string> = {
  invalid_request: "title update request is invalid",
  state_failed: "title update state operation failed",
  title_read_failed: "current title could not be read",
  conversation_read_failed: "title update conversation could not be read",
  generation_failed: "title generation failed",
  validation_failed: "generated title is invalid",
  title_write_failed: "generated title could not be saved",
};

export class TitleUpdateError extends Error {
  private constructor(readonly code: TitleUpdateErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "TitleUpdateError";
  }

  static for(code: TitleUpdateErrorCode): TitleUpdateError {
    return new TitleUpdateError(code);
  }
}

export interface TitleUpdateServiceOptions {
  store: TitleUpdateStateStore;
  provider: TitleProvider;
  transcriptReader: TitleUpdateTranscriptReader;
  sink: TitleUpdateSink;
  maxChars: number;
  clock: () => string;
}

export class TitleUpdateService {
  private readonly store: TitleUpdateStateStore;
  private readonly provider: TitleProvider;
  private readonly transcriptReader: TitleUpdateTranscriptReader;
  private readonly sink: TitleUpdateSink;
  private readonly maxChars: number;
  private readonly clock: () => string;

  constructor(options: TitleUpdateServiceOptions) {
    if (!Number.isSafeInteger(options.maxChars) || options.maxChars <= 0) {
      throw TitleUpdateError.for("invalid_request");
    }
    this.store = options.store;
    this.provider = options.provider;
    this.transcriptReader = options.transcriptReader;
    this.sink = options.sink;
    this.maxChars = options.maxChars;
    this.clock = options.clock;
  }

  async update(input: unknown): Promise<TitleUpdateResult> {
    const request = parseUpdateRequest(input);
    const state = this.readState(request.sessionId);

    if (
      !request.force &&
      state?.autoUpdateDisabled === true &&
      state.pendingTitle === null
    ) {
      return { status: "disabled" };
    }

    this.writeState("markPending", request.sessionId);
    const currentTitle = await this.readCurrentTitle(request.sessionId);

    if (!request.force && state !== undefined) {
      if (state.pendingTitle !== null) {
        if (currentTitle === state.pendingTitle) {
          this.writeState(
            state.autoUpdateDisabled ? "markForcedSuccess" : "markSuccess",
            request.sessionId,
            state.pendingTitle,
          );
          return { status: "unchanged" };
        }
        if (state.autoUpdateDisabled) {
          this.writeState("markAutoUpdateDisabled", request.sessionId);
          return { status: "disabled" };
        }
        if (state.lastAutoTitle !== null && currentTitle !== state.lastAutoTitle) {
          this.writeState("markAutoUpdateDisabled", request.sessionId);
          return { status: "manual-change" };
        }
        this.writeState("clearTitleWritePending", request.sessionId);
      } else if (
        state.lastAutoTitle !== null &&
        currentTitle !== state.lastAutoTitle
      ) {
        this.writeState("markAutoUpdateDisabled", request.sessionId);
        return { status: "manual-change" };
      }
    }

    const messages = await this.readMessages(request);
    const rawTitle = await this.generateTitle(messages, currentTitle);
    const title = this.validateGeneratedTitle(rawTitle);

    if (!request.force) {
      const confirmedTitle = await this.readCurrentTitle(request.sessionId);
      if (confirmedTitle !== currentTitle) {
        this.writeState("markAutoUpdateDisabled", request.sessionId);
        return { status: "manual-change" };
      }
    }

    if (title !== currentTitle) {
      this.writeState("markTitleWritePending", request.sessionId, title);
      await this.writeTitle(request.sessionId, title);
    }

    if (request.force) {
      this.writeState("markForcedSuccess", request.sessionId, title);
    } else {
      this.writeState("markSuccess", request.sessionId, title);
    }

    return { status: title === currentTitle ? "unchanged" : "updated" };
  }

  private readState(sessionId: string): SessionState | undefined {
    try {
      const state = this.store.getSession(sessionId);
      return state === undefined ? undefined : snapshotSessionState(state, sessionId);
    } catch {
      throw TitleUpdateError.for("state_failed");
    }
  }

  private writeState(
    operation:
      | "markPending"
      | "markTitleWritePending"
      | "clearTitleWritePending"
      | "markSuccess"
      | "markForcedSuccess"
      | "markAutoUpdateDisabled",
    sessionId: string,
    title?: string,
  ): void {
    try {
      const now = this.clock();
      if (operation === "markPending") {
        this.store.markPending(sessionId, now);
      } else if (operation === "markTitleWritePending") {
        this.store.markTitleWritePending(sessionId, requireTitle(title), now);
      } else if (operation === "clearTitleWritePending") {
        this.store.clearTitleWritePending(sessionId, now);
      } else if (operation === "markAutoUpdateDisabled") {
        this.store.markAutoUpdateDisabled(sessionId, now);
      } else if (operation === "markForcedSuccess") {
        this.store.markForcedSuccess(sessionId, requireTitle(title), now);
      } else {
        this.store.markSuccess(sessionId, requireTitle(title), now);
      }
    } catch (error) {
      if (error instanceof TitleUpdateError) throw error;
      throw TitleUpdateError.for("state_failed");
    }
  }

  private async readCurrentTitle(sessionId: string): Promise<string | undefined> {
    try {
      const title = await this.sink.readTitle(sessionId);
      if (title !== undefined && typeof title !== "string") throw new Error();
      return title;
    } catch {
      throw TitleUpdateError.for("title_read_failed");
    }
  }

  private async readMessages(request: TitleUpdateRequest): Promise<NormalizedMessage[]> {
    try {
      let messages: NormalizedMessage[];
      if (request.transcriptPath !== undefined) {
        messages = await this.transcriptReader.read(request.transcriptPath);
      } else if (request.force) {
        messages = await this.sink.readConversation(request.sessionId);
      } else {
        throw TitleUpdateError.for("conversation_read_failed");
      }
      return messages.map((message) => ({ role: message.role, content: message.content }));
    } catch (error) {
      if (error instanceof TitleUpdateError) throw error;
      throw TitleUpdateError.for("conversation_read_failed");
    }
  }

  private async generateTitle(
    messages: NormalizedMessage[],
    currentTitle: string | undefined,
  ): Promise<string> {
    const input: TitleProviderInput = {
      messages,
      ...(currentTitle === undefined ? {} : { previousTitle: currentTitle }),
      locale: "ja",
      maxChars: this.maxChars,
    };
    try {
      return await this.provider.generateTitle(input);
    } catch {
      throw TitleUpdateError.for("generation_failed");
    }
  }

  private validateGeneratedTitle(rawTitle: unknown): string {
    try {
      if (typeof rawTitle !== "string") throw TitleUpdateError.for("validation_failed");
      return validateTitle(rawTitle, this.maxChars);
    } catch (error) {
      if (error instanceof TitleUpdateError) throw error;
      throw TitleUpdateError.for("validation_failed");
    }
  }

  private async writeTitle(sessionId: string, title: string): Promise<void> {
    try {
      await this.sink.setTitle(sessionId, title);
    } catch {
      throw TitleUpdateError.for("title_write_failed");
    }
  }
}

function parseUpdateRequest(input: unknown): TitleUpdateRequest {
  try {
    if (!isPlainRecord(input)) throw new Error();
    const keys = Reflect.ownKeys(input);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          !["sessionId", "transcriptPath", "force"].includes(key),
      )
    ) {
      throw new Error();
    }
    if (!Object.hasOwn(input, "sessionId") || !Object.hasOwn(input, "force")) throw new Error();
    const sessionId = input.sessionId;
    const transcriptPath = Object.hasOwn(input, "transcriptPath") ? input.transcriptPath : undefined;
    const force = input.force;
    if (!isBoundedString(sessionId, MAX_SESSION_ID_CODE_UNITS) || typeof force !== "boolean") {
      throw new Error();
    }
    if (
      transcriptPath !== undefined &&
      (!isBoundedString(transcriptPath, MAX_TRANSCRIPT_PATH_CODE_UNITS) ||
        !isAbsolute(transcriptPath))
    ) {
      throw new Error();
    }
    return transcriptPath === undefined
      ? { sessionId, force }
      : { sessionId, transcriptPath, force };
  } catch {
    throw TitleUpdateError.for("invalid_request");
  }
}

function isBoundedString(value: unknown, maxCodeUnits: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxCodeUnits &&
    !value.includes("\0")
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireTitle(title: string | undefined): string {
  if (title === undefined) throw TitleUpdateError.for("state_failed");
  return title;
}

function snapshotSessionState(value: unknown, expectedSessionId: string): SessionState {
  if (!isPlainRecord(value)) throw new Error();
  const requiredFields = [
    "sessionId",
    "stopCount",
    "lastTurnId",
    "pendingUpdate",
    "lastAutoTitle",
    "pendingTitle",
    "autoUpdateDisabled",
    "lastSuccessAt",
    "updatedAt",
  ] as const;
  if (requiredFields.some((field) => !Object.hasOwn(value, field))) throw new Error();

  const sessionId = value.sessionId;
  const stopCount = value.stopCount;
  const lastTurnId = value.lastTurnId;
  const pendingUpdate = value.pendingUpdate;
  const lastAutoTitle = value.lastAutoTitle;
  const pendingTitle = value.pendingTitle;
  const autoUpdateDisabled = value.autoUpdateDisabled;
  const lastSuccessAt = value.lastSuccessAt;
  const updatedAt = value.updatedAt;

  if (
    sessionId !== expectedSessionId ||
    !Number.isSafeInteger(stopCount) ||
    (stopCount as number) < 0 ||
    !isNullableString(lastTurnId) ||
    typeof pendingUpdate !== "boolean" ||
    !isNullableString(lastAutoTitle) ||
    !isNullableString(pendingTitle) ||
    typeof autoUpdateDisabled !== "boolean" ||
    !isNullableString(lastSuccessAt) ||
    typeof updatedAt !== "string"
  ) {
    throw new Error();
  }

  return {
    sessionId,
    stopCount: stopCount as number,
    lastTurnId,
    pendingUpdate,
    lastAutoTitle,
    pendingTitle,
    autoUpdateDisabled,
    lastSuccessAt,
    updatedAt,
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

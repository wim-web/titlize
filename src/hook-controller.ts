import { isAbsolute } from "node:path";
import { shouldUpdate } from "./state-store";
import type { SessionState } from "./types";
import type { TitleUpdateRequest, TitleUpdateResult } from "./title-update-service";

const MAX_ID_CODE_UNITS = 4_096;
const MAX_TRANSCRIPT_PATH_CODE_UNITS = 4_096;

export type HookLogCode =
  | "invalid_stop_input"
  | "state_store_failed"
  | "title_update_failed";

export interface HookStateStore {
  recordStop(
    sessionId: string,
    turnId: string,
    now: string,
  ): { isNewTurn: boolean; state: SessionState };
}

export interface HookTitleUpdateService {
  update(input: TitleUpdateRequest): Promise<TitleUpdateResult>;
}

export interface HookControllerOptions {
  store: HookStateStore;
  service: HookTitleUpdateService;
  every: number;
  clock: () => string;
  logger?: (code: HookLogCode) => void;
}

interface StopInput {
  sessionId: string;
  turnId: string;
  transcriptPath?: string;
}

export class HookController {
  private readonly store: HookStateStore;
  private readonly service: HookTitleUpdateService;
  private readonly every: number;
  private readonly clock: () => string;
  private readonly logger: (code: HookLogCode) => void;

  constructor(options: HookControllerOptions) {
    this.store = options.store;
    this.service = options.service;
    this.every = options.every;
    this.clock = options.clock;
    this.logger = options.logger ?? (() => undefined);
  }

  async handle(
    input: unknown,
    env: Readonly<Record<string, string | undefined>> = {},
  ): Promise<void> {
    if (env.CODEX_TITLE_CHILD === "1") return;

    let parsed: StopInput | undefined;
    try {
      if (
        !isPlainRecord(input) ||
        !Object.hasOwn(input, "hook_event_name") ||
        input.hook_event_name !== "Stop"
      ) {
        return;
      }
      parsed = parseStopInput(input);
    } catch {
      this.safeLog("invalid_stop_input");
      return;
    }

    let record: { isNewTurn: boolean; state: SessionState };
    try {
      record = this.store.recordStop(parsed.sessionId, parsed.turnId, this.clock());
      if (!record.isNewTurn || record.state.autoUpdateDisabled) return;
      if (!shouldUpdate(record.state, this.every)) return;
    } catch {
      this.safeLog("state_store_failed");
      return;
    }

    try {
      await this.service.update({
        sessionId: parsed.sessionId,
        transcriptPath: parsed.transcriptPath,
        force: false,
      });
    } catch {
      this.safeLog("title_update_failed");
    }
  }

  private safeLog(code: HookLogCode): void {
    try {
      this.logger(code);
    } catch {
      // Hook logging must never interfere with the Codex turn.
    }
  }
}

function parseStopInput(input: Record<string, unknown>): StopInput {
  if (
    !Object.hasOwn(input, "session_id") ||
    !Object.hasOwn(input, "turn_id") ||
    !Object.hasOwn(input, "transcript_path")
  ) {
    throw new Error();
  }
  const sessionId = input.session_id;
  const turnId = input.turn_id;
  const transcriptPath = input.transcript_path;

  if (
    !isBoundedString(sessionId, MAX_ID_CODE_UNITS) ||
    !isBoundedString(turnId, MAX_ID_CODE_UNITS)
  ) {
    throw new Error();
  }
  if (
    transcriptPath !== null &&
    (!isBoundedString(transcriptPath, MAX_TRANSCRIPT_PATH_CODE_UNITS) ||
      !isAbsolute(transcriptPath))
  ) {
    throw new Error();
  }
  return transcriptPath === null
    ? { sessionId, turnId }
    : { sessionId, turnId, transcriptPath };
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

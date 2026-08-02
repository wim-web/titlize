import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionState } from "./types";

type SessionRow = {
  session_id: string;
  stop_count: number;
  last_turn_id: string | null;
  pending_update: number;
  last_auto_title: string | null;
  pending_title: string | null;
  pending_previous_title: string | null;
  pending_previous_title_known: number;
  auto_update_disabled: number;
  last_success_at: string | null;
  updated_at: string;
};

type RenameAttemptPhase =
  | "awaiting_read"
  | "authorized"
  | "write_pending"
  | "denied"
  | "completed";

type RenameAttemptRow = {
  session_id: string;
  turn_id: string;
  phase: RenameAttemptPhase;
  observed_title: string | null;
  observed_title_known: number;
  updated_at: string;
};

export type RenameAttemptStart = "started" | "ignored";
export type CurrentTitleObservation =
  | "authorized"
  | "already_applied"
  | "manual_change"
  | "disabled"
  | "ignored";
export type TitleWriteDecision = "allow" | "deny" | "ignored";
export type TitleWriteCompletion = "success" | "unverified" | "ignored";

const schema = `
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    stop_count INTEGER NOT NULL CHECK(stop_count >= 0),
    last_turn_id TEXT,
    pending_update INTEGER NOT NULL CHECK(pending_update IN (0, 1)),
    last_auto_title TEXT,
    pending_title TEXT,
    pending_previous_title TEXT,
    pending_previous_title_known INTEGER NOT NULL DEFAULT 0
      CHECK(pending_previous_title_known IN (0, 1)),
    auto_update_disabled INTEGER NOT NULL CHECK(auto_update_disabled IN (0, 1)),
    last_success_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS processed_turns (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    PRIMARY KEY(session_id, turn_id),
    FOREIGN KEY(session_id) REFERENCES sessions(session_id)
  );
  CREATE TABLE IF NOT EXISTS rename_attempts (
    session_id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    phase TEXT NOT NULL
      CHECK(phase IN ('awaiting_read', 'authorized', 'write_pending', 'denied', 'completed')),
    observed_title TEXT,
    observed_title_known INTEGER NOT NULL DEFAULT 0
      CHECK(observed_title_known IN (0, 1)),
    updated_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(session_id)
  )
`;

function toSessionState(row: SessionRow): SessionState {
  return {
    sessionId: row.session_id,
    stopCount: row.stop_count,
    lastTurnId: row.last_turn_id,
    pendingUpdate: row.pending_update === 1,
    lastAutoTitle: row.last_auto_title,
    pendingTitle: row.pending_title,
    pendingPreviousTitle: row.pending_previous_title,
    pendingPreviousTitleKnown: row.pending_previous_title_known === 1,
    autoUpdateDisabled: row.auto_update_disabled === 1,
    lastSuccessAt: row.last_success_at,
    updatedAt: row.updated_at,
  };
}

export interface StateStoreOptions {
  openDatabase?: (path: string) => Database;
}

export class StateStore {
  private readonly db: Database;

  constructor(path: string, options: StateStoreOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = (options.openDatabase ?? ((databasePath) => new Database(databasePath)))(path);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec(schema);
      this.migrateTitleIntentColumns();
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Preserve the original PRAGMA, schema, or migration failure.
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  getSession(sessionId: string): SessionState | undefined {
    const row = this.db
      .query<SessionRow, [string]>("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId);
    return row === null ? undefined : toSessionState(row);
  }

  recordStop(sessionId: string, turnId: string, now: string): { isNewTurn: boolean; state: SessionState } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .query(
          `INSERT INTO sessions (
            session_id, stop_count, last_turn_id, pending_update, last_auto_title,
            pending_title, pending_previous_title, pending_previous_title_known,
            auto_update_disabled, last_success_at, updated_at
          ) VALUES (?, 0, NULL, 0, NULL, NULL, NULL, 0, 0, NULL, ?)
          ON CONFLICT(session_id) DO NOTHING`,
        )
        .run(sessionId, now);

      const processed = this.db
        .query(
          `INSERT INTO processed_turns (session_id, turn_id) VALUES (?, ?)
           ON CONFLICT(session_id, turn_id) DO NOTHING`,
        )
        .run(sessionId, turnId);
      if (processed.changes === 0) {
        const state = this.requireSession(sessionId);
        this.db.exec("COMMIT");
        return { isNewTurn: false, state };
      }

      this.db
        .query(
          "UPDATE sessions SET stop_count = stop_count + 1, last_turn_id = ?, updated_at = ? WHERE session_id = ?",
        )
        .run(turnId, now, sessionId);

      const state = this.requireSession(sessionId);
      this.db.exec("COMMIT");
      return { isNewTurn: true, state };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markPending(sessionId: string, now: string): SessionState {
    return this.upsert(sessionId, now, `pending_update = 1, updated_at = excluded.updated_at`, null, true);
  }

  markRenameContinuationFinished(sessionId: string, now: string): SessionState {
    return this.upsert(
      sessionId,
      now,
      `pending_update = 0,
       pending_title = NULL, pending_previous_title = NULL,
       pending_previous_title_known = 0,
       last_success_at = excluded.last_success_at,
       updated_at = excluded.updated_at`,
      null,
      false,
      false,
      null,
      null,
      false,
      now,
    );
  }

  markSuccess(sessionId: string, title: string, now: string): SessionState {
    return this.upsert(
      sessionId,
      now,
      `pending_update = 0, last_auto_title = excluded.last_auto_title,
       pending_title = NULL, pending_previous_title = NULL,
       pending_previous_title_known = 0,
       last_success_at = excluded.last_success_at,
       updated_at = excluded.updated_at`,
      title,
    );
  }

  markForcedSuccess(sessionId: string, title: string, now: string): SessionState {
    return this.upsert(
      sessionId,
      now,
      `pending_update = 0, last_auto_title = excluded.last_auto_title, auto_update_disabled = 0,
       pending_title = NULL, pending_previous_title = NULL,
       pending_previous_title_known = 0,
       last_success_at = excluded.last_success_at,
       updated_at = excluded.updated_at`,
      title,
    );
  }

  markAutoUpdateDisabled(sessionId: string, now: string): SessionState {
    return this.upsert(
      sessionId,
      now,
      `pending_update = 0, pending_title = NULL, pending_previous_title = NULL,
       pending_previous_title_known = 0,
       auto_update_disabled = 1,
       updated_at = excluded.updated_at`,
      null,
      false,
      true,
    );
  }

  markTitleWritePending(
    sessionId: string,
    title: string,
    previousTitle: string | null,
    now: string,
  ): SessionState {
    return this.upsert(
      sessionId,
      now,
      `pending_update = 1, pending_title = excluded.pending_title,
       pending_previous_title = excluded.pending_previous_title,
       pending_previous_title_known = 1,
       updated_at = excluded.updated_at`,
      null,
      true,
      false,
      title,
      previousTitle,
      true,
    );
  }

  clearTitleWritePending(sessionId: string, now: string): SessionState {
    return this.upsert(
      sessionId,
      now,
      `pending_update = 1, pending_title = NULL, pending_previous_title = NULL,
       pending_previous_title_known = 0,
       updated_at = excluded.updated_at`,
      null,
      true,
    );
  }

  beginRenameAttempt(sessionId: string, turnId: string, now: string): RenameAttemptStart {
    return this.transaction(() => {
      const state = this.getSession(sessionId);
      if (
        state === undefined ||
        !state.pendingUpdate ||
        (state.autoUpdateDisabled && state.pendingTitle === null)
      ) {
        return "ignored";
      }

      const existing = this.getRenameAttempt(sessionId);
      if (existing?.turn_id === turnId) return "ignored";

      this.db
        .query(
          `INSERT INTO rename_attempts (
             session_id, turn_id, phase, observed_title, observed_title_known, updated_at
           ) VALUES (?, ?, 'awaiting_read', NULL, 0, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             turn_id = excluded.turn_id,
             phase = 'awaiting_read',
             observed_title = NULL,
             observed_title_known = 0,
             updated_at = excluded.updated_at`,
        )
        .run(sessionId, turnId, now);
      return "started";
    });
  }

  isTitleReadExpected(sessionId: string, turnId: string): boolean {
    const attempt = this.getRenameAttempt(sessionId);
    return attempt?.turn_id === turnId && attempt.phase === "awaiting_read";
  }

  observeCurrentTitle(
    sessionId: string,
    turnId: string,
    currentTitle: string | null,
    now: string,
  ): CurrentTitleObservation {
    return this.transaction(() => {
      const attempt = this.getRenameAttempt(sessionId);
      if (attempt?.turn_id !== turnId || attempt.phase !== "awaiting_read") {
        return "ignored";
      }

      let state = this.getSession(sessionId);
      if (state === undefined) return "ignored";

      if (state.pendingTitle !== null) {
        if (currentTitle === state.pendingTitle) {
          this.db
            .query(
              `UPDATE sessions SET
                 pending_update = 0,
                 last_auto_title = pending_title,
                 pending_title = NULL,
                 pending_previous_title = NULL,
                 pending_previous_title_known = 0,
                 last_success_at = ?,
                 updated_at = ?
               WHERE session_id = ?`,
            )
            .run(now, now, sessionId);
          this.finishRenameAttempt(sessionId, turnId, "completed", now);
          return "already_applied";
        }

        if (
          state.pendingPreviousTitleKnown &&
          currentTitle === state.pendingPreviousTitle
        ) {
          this.db
            .query(
              `UPDATE sessions SET
                 pending_title = NULL,
                 pending_previous_title = NULL,
                 pending_previous_title_known = 0,
                 updated_at = ?
               WHERE session_id = ?`,
            )
            .run(now, sessionId);
          state = this.requireSession(sessionId);
        } else {
          this.disableAutoUpdate(sessionId, now);
          this.finishRenameAttempt(sessionId, turnId, "denied", now);
          return "manual_change";
        }
      }

      if (state.autoUpdateDisabled) {
        this.db
          .query("UPDATE sessions SET pending_update = 0, updated_at = ? WHERE session_id = ?")
          .run(now, sessionId);
        this.finishRenameAttempt(sessionId, turnId, "denied", now);
        return "disabled";
      }

      if (state.lastAutoTitle !== null && currentTitle !== state.lastAutoTitle) {
        this.disableAutoUpdate(sessionId, now);
        this.finishRenameAttempt(sessionId, turnId, "denied", now);
        return "manual_change";
      }

      this.db
        .query(
          `UPDATE rename_attempts SET
             phase = 'authorized', observed_title = ?, observed_title_known = 1, updated_at = ?
           WHERE session_id = ? AND turn_id = ?`,
        )
        .run(currentTitle, now, sessionId, turnId);
      return "authorized";
    });
  }

  prepareTitleWrite(
    sessionId: string,
    turnId: string,
    title: string,
    now: string,
  ): TitleWriteDecision {
    return this.transaction(() => {
      const attempt = this.getRenameAttempt(sessionId);
      if (attempt?.turn_id !== turnId) return "ignored";
      if (attempt.phase !== "authorized" || attempt.observed_title_known !== 1) {
        return "deny";
      }

      const state = this.getSession(sessionId);
      if (state === undefined || state.autoUpdateDisabled) {
        this.finishRenameAttempt(sessionId, turnId, "denied", now);
        return "deny";
      }

      this.db
        .query(
          `UPDATE sessions SET
             pending_update = 1,
             pending_title = ?,
             pending_previous_title = ?,
             pending_previous_title_known = 1,
             updated_at = ?
           WHERE session_id = ?`,
        )
        .run(title, attempt.observed_title, now, sessionId);
      this.finishRenameAttempt(sessionId, turnId, "write_pending", now);
      return "allow";
    });
  }

  completeTitleWrite(
    sessionId: string,
    turnId: string,
    succeeded: boolean,
    now: string,
  ): TitleWriteCompletion {
    return this.transaction(() => {
      const attempt = this.getRenameAttempt(sessionId);
      if (attempt?.turn_id !== turnId || attempt.phase !== "write_pending") {
        return "ignored";
      }

      const state = this.getSession(sessionId);
      if (state === undefined || state.pendingTitle === null) {
        this.finishRenameAttempt(sessionId, turnId, "completed", now);
        return "unverified";
      }

      if (!succeeded) {
        this.finishRenameAttempt(sessionId, turnId, "completed", now);
        return "unverified";
      }

      this.db
        .query(
          `UPDATE sessions SET
             pending_update = 0,
             last_auto_title = pending_title,
             pending_title = NULL,
             pending_previous_title = NULL,
             pending_previous_title_known = 0,
             last_success_at = ?,
             updated_at = ?
           WHERE session_id = ?`,
        )
        .run(now, now, sessionId);
      this.finishRenameAttempt(sessionId, turnId, "completed", now);
      return "success";
    });
  }

  private upsert(
    sessionId: string,
    now: string,
    updates: string,
    title: string | null = null,
    pendingUpdate = false,
    autoUpdateDisabled = false,
    pendingTitle: string | null = null,
    pendingPreviousTitle: string | null = null,
    pendingPreviousTitleKnown = false,
    lastSuccessAt: string | null = title === null ? null : now,
  ): SessionState {
    this.db
      .query(
        `INSERT INTO sessions (
          session_id, stop_count, last_turn_id, pending_update, last_auto_title,
          pending_title, pending_previous_title, pending_previous_title_known,
          auto_update_disabled, last_success_at, updated_at
        ) VALUES (?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET ${updates}`,
      )
      .run(
        sessionId,
        pendingUpdate ? 1 : 0,
        title,
        pendingTitle,
        pendingPreviousTitle,
        pendingPreviousTitleKnown ? 1 : 0,
        autoUpdateDisabled ? 1 : 0,
        lastSuccessAt,
        now,
      );
    return this.requireSession(sessionId);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the operation failure rather than a cleanup failure.
      }
      throw error;
    }
  }

  private getRenameAttempt(sessionId: string): RenameAttemptRow | undefined {
    const row = this.db
      .query<RenameAttemptRow, [string]>(
        "SELECT * FROM rename_attempts WHERE session_id = ?",
      )
      .get(sessionId);
    return row === null ? undefined : row;
  }

  private finishRenameAttempt(
    sessionId: string,
    turnId: string,
    phase: RenameAttemptPhase,
    now: string,
  ): void {
    this.db
      .query(
        `UPDATE rename_attempts SET phase = ?, updated_at = ?
         WHERE session_id = ? AND turn_id = ?`,
      )
      .run(phase, now, sessionId, turnId);
  }

  private disableAutoUpdate(sessionId: string, now: string): void {
    this.db
      .query(
        `UPDATE sessions SET
           pending_update = 0,
           pending_title = NULL,
           pending_previous_title = NULL,
           pending_previous_title_known = 0,
           auto_update_disabled = 1,
           updated_at = ?
         WHERE session_id = ?`,
      )
      .run(now, sessionId);
  }

  private migrateTitleIntentColumns(): void {
    if (this.hasTitleIntentColumns()) return;

    let transactionOpen = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const columns = this.sessionColumnNames();
      if (!columns.has("pending_title")) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN pending_title TEXT");
      }
      if (!columns.has("pending_previous_title")) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN pending_previous_title TEXT");
      }
      if (!columns.has("pending_previous_title_known")) {
        this.db.exec(
          `ALTER TABLE sessions ADD COLUMN pending_previous_title_known INTEGER NOT NULL
           DEFAULT 0 CHECK(pending_previous_title_known IN (0, 1))`,
        );
      }
      if (!columns.has("pending_previous_title")) {
        // Candidate-only legacy intents can use the last owned title as their baseline.
        // A first intent has no reconstructable baseline and stays unknown (0), so it
        // cannot later overwrite a possibly manual title.
        this.db.exec(
          `UPDATE sessions
           SET pending_previous_title = last_auto_title,
               pending_previous_title_known = CASE
                 WHEN last_auto_title IS NOT NULL THEN 1 ELSE 0
               END
           WHERE pending_title IS NOT NULL`,
        );
      } else if (!columns.has("pending_previous_title_known")) {
        // Databases from the previous release have no marker. Preserve an exact
        // non-null baseline, otherwise use the last owned title when one exists.
        // Remaining null baselines are treated conservatively as unknown.
        this.db.exec(
          `UPDATE sessions
           SET pending_previous_title = CASE
                 WHEN pending_title IS NOT NULL AND pending_previous_title IS NULL
                   THEN last_auto_title
                 ELSE pending_previous_title
               END,
               pending_previous_title_known = CASE
                 WHEN pending_title IS NOT NULL AND
                   (pending_previous_title IS NOT NULL OR last_auto_title IS NOT NULL)
                   THEN 1
                 ELSE 0
               END`,
        );
      }
      this.db.exec("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Preserve the migration failure rather than a cleanup failure.
        }
      }
      throw error;
    }
  }

  private hasTitleIntentColumns(): boolean {
    const columns = this.sessionColumnNames();
    return (
      columns.has("pending_title") &&
      columns.has("pending_previous_title") &&
      columns.has("pending_previous_title_known")
    );
  }

  private sessionColumnNames(): Set<string> {
    return new Set(this.db
      .query<{ name: string }, []>("PRAGMA table_info(sessions)")
      .all()
      .map((column) => column.name));
  }

  private requireSession(sessionId: string): SessionState {
    const state = this.getSession(sessionId);
    if (state === undefined) throw new Error(`Session not found after write: ${sessionId}`);
    return state;
  }
}

export function shouldUpdate(
  state: Pick<SessionState, "stopCount" | "pendingUpdate">,
  every: number,
): boolean {
  if (every <= 0) return false;
  return state.pendingUpdate || (state.stopCount > 0 && state.stopCount % every === 0);
}

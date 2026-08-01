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
        title === null ? null : now,
        now,
      );
    return this.requireSession(sessionId);
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

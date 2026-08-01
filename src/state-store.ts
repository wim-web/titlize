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
    autoUpdateDisabled: row.auto_update_disabled === 1,
    lastSuccessAt: row.last_success_at,
    updatedAt: row.updated_at,
  };
}

export class StateStore {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(schema);
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
            auto_update_disabled, last_success_at, updated_at
          ) VALUES (?, 0, NULL, 0, NULL, 0, NULL, ?)
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
       last_success_at = excluded.last_success_at, updated_at = excluded.updated_at`,
      title,
    );
  }

  markForcedSuccess(sessionId: string, title: string, now: string): SessionState {
    return this.upsert(
      sessionId,
      now,
      `pending_update = 0, last_auto_title = excluded.last_auto_title, auto_update_disabled = 0,
       last_success_at = excluded.last_success_at, updated_at = excluded.updated_at`,
      title,
    );
  }

  markAutoUpdateDisabled(sessionId: string, now: string): SessionState {
    return this.upsert(
      sessionId,
      now,
      `pending_update = 0, auto_update_disabled = 1, updated_at = excluded.updated_at`,
      null,
      false,
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
  ): SessionState {
    this.db
      .query(
        `INSERT INTO sessions (
          session_id, stop_count, last_turn_id, pending_update, last_auto_title,
          auto_update_disabled, last_success_at, updated_at
        ) VALUES (?, 0, NULL, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET ${updates}`,
      )
      .run(
        sessionId,
        pendingUpdate ? 1 : 0,
        title,
        autoUpdateDisabled ? 1 : 0,
        title === null ? null : now,
        now,
      );
    return this.requireSession(sessionId);
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

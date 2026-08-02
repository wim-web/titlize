import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export const MAX_APP_TITLE_CODE_UNITS = 16_384;

const APP_STATE_FILE_PATTERN = /^state_(\d+)\.sqlite$/;

export type TitleReadResult = { ok: true; title: string } | { ok: false };

export interface AppTitleReader {
  readCurrentTitle(threadId: string): TitleReadResult;
}

// The Codex app persists thread metadata in $CODEX_HOME/state_<N>.sqlite and
// bumps <N> on schema changes. Pick the newest so app updates keep working as
// long as threads(id, title) survives; a failed read is reported as ok:false.
export function resolveAppStatePath(
  codexHome: string,
  override?: string,
): string | undefined {
  if (override !== undefined) return override;

  let entries: string[];
  try {
    entries = readdirSync(codexHome);
  } catch {
    return undefined;
  }

  let bestVersion = -1;
  let bestName: string | undefined;
  for (const entry of entries) {
    const match = APP_STATE_FILE_PATTERN.exec(entry);
    if (match === null) continue;
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version <= bestVersion) continue;
    bestVersion = version;
    bestName = entry;
  }
  return bestName === undefined ? undefined : join(codexHome, bestName);
}

export class AppDbTitleReader implements AppTitleReader {
  constructor(private readonly path: string | undefined) {}

  readCurrentTitle(threadId: string): TitleReadResult {
    if (this.path === undefined) return { ok: false };

    let db: Database | undefined;
    try {
      db = new Database(this.path, { readonly: true });
      db.exec("PRAGMA busy_timeout = 2000");
      const row = db
        .query<{ title: unknown }, [string]>(
          "SELECT title FROM threads WHERE id = ?",
        )
        .get(threadId);
      if (row === null) return { ok: false };
      const title = row.title;
      if (
        typeof title !== "string" ||
        title.length > MAX_APP_TITLE_CODE_UNITS ||
        title.includes("\0")
      ) {
        return { ok: false };
      }
      return { ok: true, title };
    } catch {
      return { ok: false };
    } finally {
      try {
        db?.close();
      } catch {
        // A close failure must not mask the read result.
      }
    }
  }
}

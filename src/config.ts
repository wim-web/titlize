import { homedir } from "node:os";
import { join } from "node:path";
import type { TitleConfig } from "./types";

const DEFAULTS = {
  every: 3,
  maxChars: 40,
} as const;

function positiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${name}`);
  }
  return parsed;
}

function nonBlank(value: string | undefined, name: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (value.trim() === "") throw new Error(`Invalid ${name}`);
  return value;
}

export function loadConfig(env: Record<string, string | undefined>): TitleConfig {
  const statePath = nonBlank(
    env.CODEX_TITLE_STATE_PATH,
    "CODEX_TITLE_STATE_PATH",
    env.CODEX_HOME
      ? join(env.CODEX_HOME, "codex-title", "state.sqlite3")
      : join(homedir(), ".codex", "codex-title", "state.sqlite3"),
  );

  return {
    every: positiveInteger(
      env.CODEX_TITLE_EVERY,
      "CODEX_TITLE_EVERY",
      DEFAULTS.every,
    ),
    maxChars: positiveInteger(
      env.CODEX_TITLE_MAX_CHARS,
      "CODEX_TITLE_MAX_CHARS",
      DEFAULTS.maxChars,
    ),
    statePath,
  };
}

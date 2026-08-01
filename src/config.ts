import { homedir } from "node:os";
import { join } from "node:path";
import type { TitleConfig } from "./types";

const DEFAULTS = {
  every: 3,
  provider: "codex",
  model: "gpt-5.6-luna",
  maxChars: 40,
  timeoutMs: 30000,
  appServer: "stdio://",
} as const;

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${name}`);
  }

  return parsed;
}

function nonBlank(value: string | undefined, name: string, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }

  if (value.trim() === "") {
    throw new Error(`Invalid ${name}`);
  }

  return value;
}

export function loadConfig(env: Record<string, string | undefined>): TitleConfig {
  const provider = env.CODEX_TITLE_PROVIDER ?? DEFAULTS.provider;
  if (provider !== "codex") {
    throw new Error("Invalid CODEX_TITLE_PROVIDER");
  }

  const appServer = env.CODEX_TITLE_APP_SERVER ?? DEFAULTS.appServer;
  if (appServer !== "stdio://") {
    throw new Error("Invalid CODEX_TITLE_APP_SERVER");
  }

  const statePath = nonBlank(
    env.CODEX_TITLE_STATE_PATH,
    "CODEX_TITLE_STATE_PATH",
    env.CODEX_HOME
      ? join(env.CODEX_HOME, "codex-title", "state.sqlite3")
      : join(homedir(), ".codex", "codex-title", "state.sqlite3"),
  );

  return {
    every: positiveInteger(env.CODEX_TITLE_EVERY, "CODEX_TITLE_EVERY", DEFAULTS.every),
    provider,
    model: nonBlank(env.CODEX_TITLE_MODEL, "CODEX_TITLE_MODEL", DEFAULTS.model),
    maxChars: positiveInteger(
      env.CODEX_TITLE_MAX_CHARS,
      "CODEX_TITLE_MAX_CHARS",
      DEFAULTS.maxChars,
    ),
    timeoutMs: positiveInteger(
      env.CODEX_TITLE_TIMEOUT_MS,
      "CODEX_TITLE_TIMEOUT_MS",
      DEFAULTS.timeoutMs,
    ),
    statePath,
    appServer,
  };
}

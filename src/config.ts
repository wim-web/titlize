import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TitleConfig } from "./types";

export const TITLE_CONFIG_FILE_NAME = "titlize.json";

export const DEFAULT_TITLE_CONFIG_FILE = {
  every: 3,
  maxChars: 40,
} as const;

const CONFIG_KEYS = new Set(["every", "maxChars", "statePath"]);

interface TitleConfigFile {
  every?: number;
  maxChars?: number;
  statePath?: string;
}

export interface LoadConfigOptions {
  readFile?: (path: string) => string | undefined;
}

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

function readOptionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw new Error("Unable to read title config");
  }
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(`Invalid config ${name}`);
  }
  return value;
}

function optionalNonBlank(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid config ${name}`);
  }
  return value;
}

function parseConfigFile(contents: string | undefined): TitleConfigFile {
  if (contents === undefined) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("Invalid title config JSON");
  }
  if (!isObject(parsed)) throw new Error("Invalid title config");

  for (const key of Object.keys(parsed)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`Invalid config key: ${key}`);
  }

  return {
    every: optionalPositiveInteger(parsed.every, "every"),
    maxChars: optionalPositiveInteger(parsed.maxChars, "maxChars"),
    statePath: optionalNonBlank(parsed.statePath, "statePath"),
  };
}

export function resolveConfigPath(
  env: Record<string, string | undefined>,
): string {
  return nonBlank(
    env.CODEX_TITLE_CONFIG_PATH,
    "CODEX_TITLE_CONFIG_PATH",
    env.CODEX_HOME
      ? join(env.CODEX_HOME, TITLE_CONFIG_FILE_NAME)
      : join(homedir(), ".codex", TITLE_CONFIG_FILE_NAME),
  );
}

export function loadConfig(
  env: Record<string, string | undefined>,
  options: LoadConfigOptions = {},
): TitleConfig {
  const configPath = resolveConfigPath(env);
  const fileConfig = parseConfigFile(
    (options.readFile ?? readOptionalFile)(configPath),
  );
  const statePath = nonBlank(
    env.CODEX_TITLE_STATE_PATH,
    "CODEX_TITLE_STATE_PATH",
    fileConfig.statePath ??
      (env.CODEX_HOME
        ? join(env.CODEX_HOME, "codex-title", "state.sqlite3")
        : join(homedir(), ".codex", "codex-title", "state.sqlite3")),
  );

  return {
    every: positiveInteger(
      env.CODEX_TITLE_EVERY,
      "CODEX_TITLE_EVERY",
      fileConfig.every ?? DEFAULT_TITLE_CONFIG_FILE.every,
    ),
    maxChars: positiveInteger(
      env.CODEX_TITLE_MAX_CHARS,
      "CODEX_TITLE_MAX_CHARS",
      fileConfig.maxChars ?? DEFAULT_TITLE_CONFIG_FILE.maxChars,
    ),
    statePath,
  };
}

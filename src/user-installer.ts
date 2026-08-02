import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  DEFAULT_TITLE_CONFIG_FILE,
  TITLE_CONFIG_FILE_NAME,
} from "./config";

export const TITLIZE_HOOK_STATUS_MESSAGE = "titlize: タスク名を更新しています";
export const TITLIZE_HOOK_TIMEOUT_SECONDS = 150;
export const TITLIZE_PROMPT_HOOK_TIMEOUT_SECONDS = 30;

type JsonObject = Record<string, unknown>;

export class UserInstallerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "UserInstallerError";
  }
}

export interface UserInstallOptions {
  codexHome: string;
  binDirectory: string;
  cliSource: string;
}

export interface UserInstallResult {
  cliPath: string;
  configPath: string;
  hooksPath: string;
}

export interface UserUninstallOptions {
  codexHome: string;
  binDirectory: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}

function validateAbsolutePath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    throw new UserInstallerError("install_path_invalid");
  }
}

function shellQuote(value: string): string {
  return `'${value.split("'").join("'\"'\"'")}'`;
}

function isTitlizeHandler(value: unknown): boolean {
  return isObject(value) && value.statusMessage === TITLIZE_HOOK_STATUS_MESSAGE;
}

function validateHookGroups(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new UserInstallerError("user_hooks_invalid");

  for (const group of value) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      throw new UserInstallerError("user_hooks_invalid");
    }
  }

  return value;
}

function removeTitlizeHandlers(groups: unknown[]): {
  groups: unknown[];
  removed: boolean;
} {
  let removed = false;
  const nextGroups: unknown[] = [];

  for (const groupValue of groups) {
    const group = groupValue as JsonObject;
    const handlers = group.hooks as unknown[];
    const filtered = handlers.filter((handler) => {
      if (!isTitlizeHandler(handler)) return true;
      removed = true;
      return false;
    });

    if (filtered.length > 0) {
      nextGroups.push({ ...group, hooks: filtered });
    }
  }

  return { groups: nextGroups, removed };
}

async function readHooksConfig(hooksPath: string): Promise<JsonObject> {
  let text: string;
  try {
    text = await readFile(hooksPath, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { hooks: {} };
    throw new UserInstallerError("user_hooks_unreadable");
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) throw new UserInstallerError("user_hooks_invalid");
    if (parsed.hooks !== undefined && !isObject(parsed.hooks)) {
      throw new UserInstallerError("user_hooks_invalid");
    }
    return parsed;
  } catch (error) {
    if (error instanceof UserInstallerError) throw error;
    throw new UserInstallerError("user_hooks_invalid");
  }
}

async function fileMode(path: string, fallback: number): Promise<number> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return fallback;
    throw new UserInstallerError("user_hooks_unreadable");
  }
}

async function atomicWrite(path: string, contents: string, mode: number): Promise<void> {
  const temporaryPath = `${path}.titlize-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { mode });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function atomicCopy(source: string, destination: string): Promise<void> {
  const temporaryPath = `${destination}.titlize-${process.pid}-${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporaryPath);
    await chmod(temporaryPath, 0o755);
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function createDefaultConfig(path: string): Promise<void> {
  try {
    await writeFile(
      path,
      `${JSON.stringify(DEFAULT_TITLE_CONFIG_FILE, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (hasCode(error, "EEXIST")) return;
    throw error;
  }
}

function installPaths(
  codexHome: string,
  binDirectory: string,
): UserInstallResult & { legacyDirectory: string } {
  return {
    legacyDirectory: join(codexHome, "titlize"),
    cliPath: join(binDirectory, "titlize"),
    configPath: join(codexHome, TITLE_CONFIG_FILE_NAME),
    hooksPath: join(codexHome, "hooks.json"),
  };
}

export async function installUser(options: UserInstallOptions): Promise<UserInstallResult> {
  validateAbsolutePath(options.codexHome);
  validateAbsolutePath(options.binDirectory);
  validateAbsolutePath(options.cliSource);

  const paths = installPaths(options.codexHome, options.binDirectory);
  const config = await readHooksConfig(paths.hooksPath);
  const hooks = (config.hooks ?? {}) as JsonObject;
  const stopGroups = removeTitlizeHandlers(validateHookGroups(hooks.Stop)).groups;
  const promptGroups = removeTitlizeHandlers(validateHookGroups(hooks.UserPromptSubmit)).groups;
  const preToolGroups = removeTitlizeHandlers(validateHookGroups(hooks.PreToolUse)).groups;
  const postToolGroups = removeTitlizeHandlers(validateHookGroups(hooks.PostToolUse)).groups;
  const command = `${shellQuote(paths.cliPath)} hook`;

  // Title reads and write verification happen against the app state DB, so
  // only Stop and UserPromptSubmit are installed. PreToolUse/PostToolUse
  // entries from older releases are removed; the keys survive only when the
  // user has their own handlers there.
  const nextHooks: JsonObject = {
    ...hooks,
    Stop: [
      ...stopGroups,
      {
        hooks: [
          {
            type: "command",
            command,
            timeout: TITLIZE_HOOK_TIMEOUT_SECONDS,
            statusMessage: TITLIZE_HOOK_STATUS_MESSAGE,
          },
        ],
      },
    ],
    UserPromptSubmit: [
      ...promptGroups,
      {
        hooks: [
          {
            type: "command",
            command,
            timeout: TITLIZE_PROMPT_HOOK_TIMEOUT_SECONDS,
            statusMessage: TITLIZE_HOOK_STATUS_MESSAGE,
          },
        ],
      },
    ],
  };
  setOrDeleteHookGroups(nextHooks, "PreToolUse", preToolGroups);
  setOrDeleteHookGroups(nextHooks, "PostToolUse", postToolGroups);

  const nextConfig: JsonObject = {
    ...config,
    hooks: nextHooks,
  };

  try {
    await mkdir(options.codexHome, { recursive: true });
    await mkdir(options.binDirectory, { recursive: true });
    await createDefaultConfig(paths.configPath);
    await atomicCopy(options.cliSource, paths.cliPath);
    const mode = await fileMode(paths.hooksPath, 0o600);
    await atomicWrite(paths.hooksPath, `${JSON.stringify(nextConfig, null, 2)}\n`, mode);
    await rm(paths.legacyDirectory, { recursive: true, force: true });
    return {
      cliPath: paths.cliPath,
      configPath: paths.configPath,
      hooksPath: paths.hooksPath,
    };
  } catch (error) {
    if (error instanceof UserInstallerError) throw error;
    throw new UserInstallerError("user_install_failed");
  }
}

function setOrDeleteHookGroups(
  hooks: JsonObject,
  eventName: string,
  groups: unknown[],
): void {
  if (groups.length > 0) {
    hooks[eventName] = groups;
  } else {
    delete hooks[eventName];
  }
}

export async function uninstallUser(options: UserUninstallOptions): Promise<UserInstallResult> {
  validateAbsolutePath(options.codexHome);
  validateAbsolutePath(options.binDirectory);
  const paths = installPaths(options.codexHome, options.binDirectory);
  const config = await readHooksConfig(paths.hooksPath);
  const hooks = (config.hooks ?? {}) as JsonObject;
  const nextHooks: JsonObject = { ...hooks };
  let removedAny = false;
  for (const eventName of ["Stop", "UserPromptSubmit", "PreToolUse", "PostToolUse"] as const) {
    const removal = removeTitlizeHandlers(validateHookGroups(nextHooks[eventName]));
    if (!removal.removed) continue;
    removedAny = true;
    if (removal.groups.length > 0) {
      nextHooks[eventName] = removal.groups;
    } else {
      delete nextHooks[eventName];
    }
  }

  if (removedAny) {
    const nextConfig: JsonObject = { ...config, hooks: nextHooks };
    try {
      const mode = await fileMode(paths.hooksPath, 0o600);
      await atomicWrite(paths.hooksPath, `${JSON.stringify(nextConfig, null, 2)}\n`, mode);
    } catch (error) {
      if (error instanceof UserInstallerError) throw error;
      throw new UserInstallerError("user_uninstall_failed");
    }
  }

  try {
    await rm(paths.cliPath, { force: true });
    await rm(paths.legacyDirectory, { recursive: true, force: true });
  } catch {
    throw new UserInstallerError("user_uninstall_failed");
  }

  return {
    cliPath: paths.cliPath,
    configPath: paths.configPath,
    hooksPath: paths.hooksPath,
  };
}

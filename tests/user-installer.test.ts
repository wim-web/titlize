import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installUser,
  TITLIZE_HOOK_STATUS_MESSAGE,
  uninstallUser,
  UserInstallerError,
} from "../src/user-installer";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const path = temporaryDirectories.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "titlize-user-installer-"));
  temporaryDirectories.push(root);

  const codexHome = join(root, "codex home");
  const cliSource = join(root, "compiled-titlize");
  const binDirectory = join(root, "bin dir");
  await writeFile(cliSource, "compiled-cli\n");

  return { root, codexHome, cliSource, binDirectory };
}

function titlizeHandlers(
  config: Record<string, any>,
  eventName: "Stop" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse",
): Array<Record<string, any>> {
  return (config.hooks?.[eventName] ?? []).flatMap((group: Record<string, any>) =>
    (group.hooks ?? []).filter(
      (handler: Record<string, any>) =>
        handler.statusMessage === TITLIZE_HOOK_STATUS_MESSAGE,
    ),
  );
}

describe("user installer", () => {
  test("プロジェクト限定Hookを同梱しない", async () => {
    expect(await Bun.file(join(import.meta.dir, "..", ".codex", "hooks.json")).exists()).toBe(
      false,
    );
  });

  test("既存Hookを保持してStop/UserPromptSubmitのHookと単体CLIを追加する", async () => {
    const { codexHome, cliSource, binDirectory } = await fixture();
    await mkdir(codexHome, { recursive: true });
    const existing = {
      description: "existing user hooks",
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "bash /existing/session-start.sh",
                timeout: 10,
              },
            ],
          },
        ],
        Stop: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: "bash /existing/stop.sh",
                timeout: 5,
              },
            ],
          },
        ],
      },
    };
    await writeFile(join(codexHome, "hooks.json"), `${JSON.stringify(existing, null, 2)}\n`);

    const result = await installUser({
      codexHome,
      binDirectory,
      cliSource,
    });

    expect(result.cliPath).toBe(join(binDirectory, "titlize"));
    expect(await readFile(result.cliPath, "utf8")).toBe("compiled-cli\n");
    expect((await stat(result.cliPath)).mode & 0o777).toBe(0o755);
    expect(result.configPath).toBe(join(codexHome, "titlize.json"));
    expect(JSON.parse(await readFile(result.configPath, "utf8"))).toEqual({
      every: 3,
      maxChars: 40,
    });
    expect((await stat(result.configPath)).mode & 0o777).toBe(0o600);

    const installed = JSON.parse(await readFile(result.hooksPath, "utf8"));
    expect(installed.description).toBe("existing user hooks");
    expect(installed.hooks.SessionStart).toEqual(existing.hooks.SessionStart);
    expect(installed.hooks.Stop[0]).toEqual(existing.hooks.Stop[0]);

    const stopHandlers = titlizeHandlers(installed, "Stop");
    expect(stopHandlers).toHaveLength(1);
    expect(stopHandlers[0]).toMatchObject({
      type: "command",
      timeout: 150,
      statusMessage: TITLIZE_HOOK_STATUS_MESSAGE,
    });
    expect(stopHandlers[0]?.command).toBe(`'${join(binDirectory, "titlize")}' hook`);

    const promptHandlers = titlizeHandlers(installed, "UserPromptSubmit");
    expect(promptHandlers).toHaveLength(1);
    expect(promptHandlers[0]).toMatchObject({
      type: "command",
      timeout: 30,
      statusMessage: TITLIZE_HOOK_STATUS_MESSAGE,
    });
    expect(promptHandlers[0]?.command).toBe(`'${join(binDirectory, "titlize")}' hook`);

    expect(installed.hooks.PreToolUse).toBeUndefined();
    expect(installed.hooks.PostToolUse).toBeUndefined();
  });

  test("旧リリースのPreToolUse/PostToolUseエントリを撤去し、ユーザー自前のものは残す", async () => {
    const { codexHome, cliSource, binDirectory } = await fixture();
    await mkdir(codexHome, { recursive: true });
    const titlizeHandler = {
      type: "command",
      command: "'/old/titlize' hook",
      timeout: 30,
      statusMessage: TITLIZE_HOOK_STATUS_MESSAGE,
    };
    const userHandler = {
      type: "command",
      command: "bash /existing/pre-tool.sh",
      timeout: 5,
    };
    const existing = {
      hooks: {
        PreToolUse: [
          { matcher: "^codex_app__set_thread_title$", hooks: [titlizeHandler] },
          { matcher: "^Bash$", hooks: [userHandler] },
        ],
        PostToolUse: [
          { matcher: "^(?:codex_appread_thread|codex_app__read_thread)$", hooks: [titlizeHandler] },
          { matcher: "^(?:codex_appset_thread_title|codex_app__set_thread_title)$", hooks: [titlizeHandler] },
        ],
      },
    };
    await writeFile(join(codexHome, "hooks.json"), `${JSON.stringify(existing, null, 2)}\n`);

    const result = await installUser({ codexHome, binDirectory, cliSource });

    const installed = JSON.parse(await readFile(result.hooksPath, "utf8"));
    expect(titlizeHandlers(installed, "PreToolUse")).toHaveLength(0);
    expect(titlizeHandlers(installed, "PostToolUse")).toHaveLength(0);
    expect(installed.hooks.PreToolUse).toEqual([
      { matcher: "^Bash$", hooks: [userHandler] },
    ]);
    expect(installed.hooks.PostToolUse).toBeUndefined();
    expect(titlizeHandlers(installed, "Stop")).toHaveLength(1);
    expect(titlizeHandlers(installed, "UserPromptSubmit")).toHaveLength(1);
  });

  test("再インストールしてもtitlize Hookを重複させない", async () => {
    const { codexHome, cliSource, binDirectory } = await fixture();
    const options = {
      codexHome,
      binDirectory,
      cliSource,
    };

    await installUser(options);
    const configPath = join(codexHome, "titlize.json");
    const customConfig = '{"every":9,"maxChars":24}\n';
    await writeFile(configPath, customConfig);
    await writeFile(cliSource, "updated-cli\n");
    await installUser(options);

    const installed = JSON.parse(await readFile(join(codexHome, "hooks.json"), "utf8"));
    expect(titlizeHandlers(installed, "Stop")).toHaveLength(1);
    expect(titlizeHandlers(installed, "UserPromptSubmit")).toHaveLength(1);
    expect(installed.hooks.PreToolUse).toBeUndefined();
    expect(installed.hooks.PostToolUse).toBeUndefined();
    expect(await readFile(join(binDirectory, "titlize"), "utf8")).toBe("updated-cli\n");
    expect(await readFile(configPath, "utf8")).toBe(customConfig);
  });

  test("不正な既存hooks.jsonを上書きしない", async () => {
    const { codexHome, cliSource, binDirectory } = await fixture();
    await mkdir(codexHome, { recursive: true });
    const hooksPath = join(codexHome, "hooks.json");
    await writeFile(hooksPath, "not-json\n");

    try {
      await installUser({
        codexHome,
        binDirectory,
        cliSource,
      });
      throw new Error("expected installUser to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(UserInstallerError);
      expect((error as UserInstallerError).code).toBe("user_hooks_invalid");
    }

    expect(await readFile(hooksPath, "utf8")).toBe("not-json\n");
    expect(await Bun.file(join(binDirectory, "titlize")).exists()).toBe(false);
    expect(await Bun.file(join(codexHome, "titlize.json")).exists()).toBe(false);
  });

  test("旧Bun bundle配置をインストール成功後に削除する", async () => {
    const { codexHome, cliSource, binDirectory } = await fixture();
    const legacyDirectory = join(codexHome, "titlize");
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(join(legacyDirectory, "codex-title"), "legacy-bundle\n");

    await installUser({ codexHome, binDirectory, cliSource });

    expect(await Bun.file(legacyDirectory).exists()).toBe(false);
    expect(await Bun.file(join(binDirectory, "titlize")).exists()).toBe(true);
  });

  test("アンインストールはtitlizeだけを削除して既存Hookを残す", async () => {
    const { codexHome, cliSource, binDirectory } = await fixture();
    await installUser({
      codexHome,
      binDirectory,
      cliSource,
    });
    const configPath = join(codexHome, "titlize.json");
    const customConfig = '{"every":12,"maxChars":36}\n';
    await writeFile(configPath, customConfig);

    const hooksPath = join(codexHome, "hooks.json");
    const installed = JSON.parse(await readFile(hooksPath, "utf8"));
    installed.hooks.SessionStart = [
      { hooks: [{ type: "command", command: "bash /existing.sh" }] },
    ];
    await writeFile(hooksPath, `${JSON.stringify(installed, null, 2)}\n`);

    await uninstallUser({ codexHome, binDirectory });

    const uninstalled = JSON.parse(await readFile(hooksPath, "utf8"));
    expect(titlizeHandlers(uninstalled, "Stop")).toHaveLength(0);
    expect(titlizeHandlers(uninstalled, "UserPromptSubmit")).toHaveLength(0);
    expect(titlizeHandlers(uninstalled, "PreToolUse")).toHaveLength(0);
    expect(titlizeHandlers(uninstalled, "PostToolUse")).toHaveLength(0);
    expect(uninstalled.hooks.Stop).toBeUndefined();
    expect(uninstalled.hooks.UserPromptSubmit).toBeUndefined();
    expect(uninstalled.hooks.PreToolUse).toBeUndefined();
    expect(uninstalled.hooks.PostToolUse).toBeUndefined();
    expect(uninstalled.hooks.SessionStart).toHaveLength(1);
    expect(await Bun.file(join(binDirectory, "titlize")).exists()).toBe(false);
    expect(await readFile(configPath, "utf8")).toBe(customConfig);
  });
});

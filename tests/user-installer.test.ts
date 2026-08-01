import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const bundleSource = join(root, "bundle.js");
  await writeFile(bundleSource, "console.log('bundle');\n");

  return { root, codexHome, bundleSource };
}

function titlizeHandlers(config: Record<string, any>): Array<Record<string, any>> {
  return (config.hooks?.Stop ?? []).flatMap((group: Record<string, any>) =>
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

  test("既存Hookを保持して全プロジェクト向けStop Hookとbundleを追加する", async () => {
    const { codexHome, bundleSource } = await fixture();
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
      bunExecutable: "/opt/bun's/bin/bun",
      bundleSource,
    });

    expect(result.bundlePath).toBe(join(codexHome, "titlize", "codex-title"));
    expect(await readFile(result.bundlePath, "utf8")).toBe("console.log('bundle');\n");

    const installed = JSON.parse(await readFile(result.hooksPath, "utf8"));
    expect(installed.description).toBe("existing user hooks");
    expect(installed.hooks.SessionStart).toEqual(existing.hooks.SessionStart);
    expect(installed.hooks.Stop[0]).toEqual(existing.hooks.Stop[0]);

    const handlers = titlizeHandlers(installed);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toMatchObject({
      type: "command",
      timeout: 150,
      statusMessage: TITLIZE_HOOK_STATUS_MESSAGE,
    });
    expect(handlers[0]?.command).toBe(
      `'/opt/bun'"'"'s/bin/bun' '${join(codexHome, "titlize", "codex-title")}' hook`,
    );
  });

  test("再インストールしてもtitlize Hookを重複させない", async () => {
    const { codexHome, bundleSource } = await fixture();
    const options = {
      codexHome,
      bunExecutable: "/opt/homebrew/bin/bun",
      bundleSource,
    };

    await installUser(options);
    await writeFile(bundleSource, "console.log('updated');\n");
    await installUser(options);

    const installed = JSON.parse(await readFile(join(codexHome, "hooks.json"), "utf8"));
    expect(titlizeHandlers(installed)).toHaveLength(1);
    expect(await readFile(join(codexHome, "titlize", "codex-title"), "utf8")).toBe(
      "console.log('updated');\n",
    );
  });

  test("不正な既存hooks.jsonを上書きしない", async () => {
    const { codexHome, bundleSource } = await fixture();
    await mkdir(codexHome, { recursive: true });
    const hooksPath = join(codexHome, "hooks.json");
    await writeFile(hooksPath, "not-json\n");

    try {
      await installUser({
        codexHome,
        bunExecutable: "/opt/homebrew/bin/bun",
        bundleSource,
      });
      throw new Error("expected installUser to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(UserInstallerError);
      expect((error as UserInstallerError).code).toBe("user_hooks_invalid");
    }

    expect(await readFile(hooksPath, "utf8")).toBe("not-json\n");
    expect(await Bun.file(join(codexHome, "titlize", "codex-title")).exists()).toBe(false);
  });

  test("アンインストールはtitlizeだけを削除して既存Hookを残す", async () => {
    const { codexHome, bundleSource } = await fixture();
    await installUser({
      codexHome,
      bunExecutable: "/opt/homebrew/bin/bun",
      bundleSource,
    });

    const hooksPath = join(codexHome, "hooks.json");
    const installed = JSON.parse(await readFile(hooksPath, "utf8"));
    installed.hooks.SessionStart = [
      { hooks: [{ type: "command", command: "bash /existing.sh" }] },
    ];
    await writeFile(hooksPath, `${JSON.stringify(installed, null, 2)}\n`);

    await uninstallUser({ codexHome });

    const uninstalled = JSON.parse(await readFile(hooksPath, "utf8"));
    expect(titlizeHandlers(uninstalled)).toHaveLength(0);
    expect(uninstalled.hooks.SessionStart).toHaveLength(1);
    expect(await Bun.file(join(codexHome, "titlize", "codex-title")).exists()).toBe(false);
  });
});

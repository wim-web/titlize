import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { installUser, uninstallUser, UserInstallerError } from "./user-installer";

function resolveCodexHome(env: Record<string, string | undefined>): string {
  const value = env.CODEX_HOME ?? join(homedir(), ".codex");
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new UserInstallerError("install_path_invalid");
  }
  return value;
}

async function buildBundle(repoRoot: string, bunExecutable: string): Promise<string> {
  const outputPath = join(repoRoot, "dist", "codex-title");
  await mkdir(join(repoRoot, "dist"), { recursive: true });

  const child = Bun.spawn({
    cmd: [
      bunExecutable,
      "build",
      join(repoRoot, "src", "cli.ts"),
      "--target=bun",
      `--outfile=${outputPath}`,
    ],
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });

  if ((await child.exited) !== 0) {
    throw new UserInstallerError("bundle_build_failed");
  }

  return outputPath;
}

export async function main(
  argv = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  try {
    const codexHome = resolveCodexHome(env);
    if (argv.length === 1 && argv[0] === "--uninstall") {
      const result = await uninstallUser({ codexHome });
      console.log(`titlizeを削除しました: ${result.hooksPath}`);
      return 0;
    }

    if (argv.length !== 0) {
      throw new UserInstallerError("install_arguments_invalid");
    }

    const bunExecutable = Bun.which("bun") ?? process.execPath;
    if (!isAbsolute(bunExecutable)) {
      throw new UserInstallerError("bun_not_found");
    }

    const repoRoot = join(import.meta.dir, "..");
    const bundleSource = await buildBundle(repoRoot, bunExecutable);
    const result = await installUser({ codexHome, bunExecutable, bundleSource });
    console.log(`titlizeをインストールしました: ${result.bundlePath}`);
    console.log(`ユーザー共通Hookを更新しました: ${result.hooksPath}`);
    console.log("Codexで /hooks を開き、titlizeのStop Hookを信頼してください。");
    return 0;
  } catch (error) {
    const code = error instanceof UserInstallerError ? error.code : "user_install_failed";
    console.error(`titlize: ${code}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { buildCli, BuildCliError } from "./build-cli";
import { installUser, uninstallUser, UserInstallerError } from "./user-installer";

function resolveCodexHome(env: Record<string, string | undefined>): string {
  const value = env.CODEX_HOME ?? join(homedir(), ".codex");
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new UserInstallerError("install_path_invalid");
  }
  return value;
}

function resolveBinDirectory(env: Record<string, string | undefined>): string {
  const value = env.TITLIZE_INSTALL_DIR ?? join(homedir(), ".local", "bin");
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new UserInstallerError("install_path_invalid");
  }
  return value;
}

export async function main(
  argv = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  try {
    const codexHome = resolveCodexHome(env);
    const binDirectory = resolveBinDirectory(env);
    if (argv.length === 1 && argv[0] === "--uninstall") {
      const result = await uninstallUser({ codexHome, binDirectory });
      console.log(`titlize CLIを削除しました: ${result.cliPath}`);
      console.log(`ユーザー共通Hookを更新しました: ${result.hooksPath}`);
      console.log(`設定ファイルは保持しました: ${result.configPath}`);
      return 0;
    }

    if (argv.length !== 0) {
      throw new UserInstallerError("install_arguments_invalid");
    }

    const repoRoot = join(import.meta.dir, "..");
    const cliSource = await buildCli({ repoRoot });
    const result = await installUser({ codexHome, binDirectory, cliSource });
    console.log(`titlize CLIをインストールしました: ${result.cliPath}`);
    console.log(`ユーザー共通Hookを更新しました: ${result.hooksPath}`);
    console.log(`設定ファイル: ${result.configPath}`);
    console.log("Codexで /hooks を開き、titlizeのHook（合計5件）を信頼してください。");
    return 0;
  } catch (error) {
    const code =
      error instanceof UserInstallerError || error instanceof BuildCliError
        ? error.code
        : "user_install_failed";
    console.error(`titlize: ${code}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}

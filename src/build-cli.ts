import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export class BuildCliError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BuildCliError";
  }
}

export interface BuildCliOptions {
  repoRoot: string;
  outputPath?: string;
  platform?: NodeJS.Platform;
  bunExecutable?: string;
}

async function runCommand(
  command: string[],
  cwd: string,
  options: { allowFailure?: boolean } = {},
): Promise<void> {
  const child = Bun.spawn({
    cmd: command,
    cwd,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0 && !options.allowFailure) {
    throw new BuildCliError("cli_build_failed");
  }
}

export async function buildCli(options: BuildCliOptions): Promise<string> {
  const repoRoot = options.repoRoot;
  const outputPath = options.outputPath ?? join(repoRoot, "dist", "titlize");
  const platform = options.platform ?? process.platform;
  const bunExecutable = options.bunExecutable ?? Bun.which("bun") ?? process.execPath;

  if (!isAbsolute(repoRoot) || !isAbsolute(outputPath) || !isAbsolute(bunExecutable)) {
    throw new BuildCliError("cli_build_path_invalid");
  }

  const temporaryPath = `${outputPath}.${process.pid}-${randomUUID()}.tmp`;
  await mkdir(dirname(outputPath), { recursive: true });

  try {
    await runCommand(
      [
        bunExecutable,
        "build",
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--no-compile-autoload-tsconfig",
        "--no-compile-autoload-package-json",
        join(repoRoot, "src", "cli.ts"),
        `--outfile=${temporaryPath}`,
      ],
      repoRoot,
    );

    if (platform === "darwin") {
      // Bun 1.3.12 leaves stale LC_CODE_SIGNATURE data after embedding the bundle.
      // Remove it before applying a valid local ad-hoc signature.
      await runCommand(
        ["/usr/bin/codesign", "--remove-signature", temporaryPath],
        repoRoot,
        { allowFailure: true },
      );
      await runCommand(
        ["/usr/bin/codesign", "--force", "--sign", "-", temporaryPath],
        repoRoot,
      );
      await runCommand(
        ["/usr/bin/codesign", "--verify", "--strict", temporaryPath],
        repoRoot,
      );
    }

    await chmod(temporaryPath, 0o755);
    await rename(temporaryPath, outputPath);
    return outputPath;
  } catch (error) {
    if (error instanceof BuildCliError) throw error;
    throw new BuildCliError("cli_build_failed");
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function main(): Promise<number> {
  try {
    const repoRoot = join(import.meta.dir, "..");
    const outputPath = await buildCli({ repoRoot });
    console.log(`titlize CLIをビルドしました: ${outputPath}`);
    return 0;
  } catch (error) {
    const code = error instanceof BuildCliError ? error.code : "cli_build_failed";
    console.error(`titlize: ${code}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}

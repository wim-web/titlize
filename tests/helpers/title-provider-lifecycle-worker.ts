import { BunCommandRunner } from "../../src/codex-title-provider";

const [mode, pidFile] = Bun.argv.slice(2);
if ((mode !== "signal" && mode !== "exit") || !pidFile) {
  process.exit(2);
}

if (mode === "exit") {
  void exitWhenReady(pidFile);
}

const childScript = [
  "const grandchild = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(10_000)'], {",
  "  stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',",
  "});",
  "await Bun.write(process.env.TITLE_PID_FILE, JSON.stringify({",
  "  childPid: process.pid, grandchildPid: grandchild.pid,",
  "}));",
  "await Bun.sleep(10_000);",
].join("\n");

try {
  await new BunCommandRunner(process.execPath).run({
    args: ["-e", childScript],
    env: { PATH: process.env.PATH, TITLE_PID_FILE: pidFile },
    stdin: "",
    timeoutMs: 20_000,
  });
} catch {
  // The lifecycle tests intentionally terminate this wrapper while the run is active.
}

async function exitWhenReady(path: string): Promise<never> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (await Bun.file(path).exists()) process.exit(23);
    await Bun.sleep(10);
  }
  process.exit(24);
}

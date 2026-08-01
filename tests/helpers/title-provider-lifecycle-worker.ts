import { BunCommandRunner } from "../../src/codex-title-provider";
import { appendFileSync } from "node:fs";

const [mode, pidFile, markerFile] = Bun.argv.slice(2);
if (
  (mode !== "signal" && mode !== "exit" && mode !== "host-signal" && mode !== "host-once-signal") ||
  !pidFile
) {
  process.exit(2);
}

if (mode === "host-signal" || mode === "host-once-signal") {
  if (!markerFile) process.exit(2);
  if (mode === "host-signal") {
    process.on("SIGTERM", () => appendFileSync(markerFile, "before\n"));
  } else {
    process.once("SIGTERM", () => appendFileSync(markerFile, "once\n"));
  }
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

const runPromise = new BunCommandRunner(process.execPath).run({
  args: ["-e", childScript],
  env: { PATH: process.env.PATH, TITLE_PID_FILE: pidFile },
  stdin: "",
  timeoutMs: 20_000,
  cwd: process.cwd(),
});

if (mode === "host-signal") {
  process.on("SIGTERM", () => appendFileSync(markerFile!, "after\n"));
}

try {
  await runPromise;
} catch {
  // The lifecycle tests intentionally terminate this wrapper while the run is active.
}

if (mode === "host-signal" || mode === "host-once-signal") {
  appendFileSync(markerFile!, `remaining:${process.listenerCount("SIGTERM")}\ncompleted\n`);
  process.exit(0);
}

async function exitWhenReady(path: string): Promise<never> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (await Bun.file(path).exists()) process.exit(23);
    await Bun.sleep(10);
  }
  process.exit(24);
}

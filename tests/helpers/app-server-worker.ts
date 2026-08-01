import { writeFile } from "node:fs/promises";

const mode = process.argv[2] ?? "happy";
const pidFile = process.argv[3];
let buffer = "";
let initialized = false;
let targetHandled = false;

if (mode === "nonzero") {
  process.stderr.write("worker-secret /private/sensitive/path\n");
  process.exit(7);
}

const reader = Bun.stdin.stream().getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    await handleLine(line);
  }
}

async function handleLine(line: string): Promise<void> {
  const message = JSON.parse(line) as Record<string, unknown>;
  if (message.id === 1 && message.method === "initialize") {
    if (mode === "large-stderr") {
      await new Promise<void>((resolve, reject) => {
        process.stderr.write("s".repeat(1024 * 1024), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
    if (mode === "malformed") {
      process.stdout.write("{worker-secret malformed\n");
      return;
    }
    if (mode === "oversize-line") {
      process.stdout.write(`${"x".repeat(129)}\n`);
      return;
    }
    if (mode === "oversize-total") {
      for (let index = 0; index < 20; index += 1) {
        process.stdout.write(`${JSON.stringify({ method: "notice", params: { index, pad: "x".repeat(32) } })}\n`);
      }
      return;
    }
    if (mode === "queue-overflow") {
      for (let index = 0; index < 20; index += 1) {
        process.stdout.write(`${JSON.stringify({ method: "notice", params: { index } })}\n`);
      }
      return;
    }
    if (mode === "multi-line-chunk") {
      const lines = [
        ...Array.from({ length: 12 }, (_, index) => ({
          method: "notice/many",
          params: { index },
        })),
        {
          id: 1,
          result: {
            userAgent: "helper/1",
            codexHome: "/helper/home",
            platformFamily: "unix",
            platformOs: "test",
          },
        },
      ];
      process.stdout.write(`${lines.map((value) => JSON.stringify(value)).join("\n")}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({
      id: 1,
      result: {
        userAgent: "helper/1",
        codexHome: "/helper/home",
        platformFamily: "unix",
        platformOs: "test",
      },
    })}\n`);
    return;
  }

  if (message.method === "initialized") {
    initialized = true;
    return;
  }

  if (message.id === 2) {
    if (!initialized) process.exit(9);
    targetHandled = true;
    if (mode === "timeout-tree") {
      const grandchild = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      if (pidFile) {
        await writeFile(
          pidFile,
          JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }),
          "utf8",
        );
      }
      await new Promise<never>(() => {});
    }
    process.stdout.write(`${JSON.stringify({ id: 2, result: { thread: { name: "helper-title" } } })}\n`);
  }
}

if (targetHandled) process.exit(0);

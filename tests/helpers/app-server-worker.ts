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

if (mode === "eager-tree") await startProcessTree();

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
    if (mode === "invalid-utf8") {
      process.stdout.write(Uint8Array.from([0xff, 0x0a]));
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
    const initializeLine = JSON.stringify({
      id: 1,
      result: {
        userAgent: "helper/1",
        codexHome: "/helper/home",
        platformFamily: "unix",
        platformOs: "test",
      },
    });
    process.stdout.write(`${initializeLine}${mode === "crlf" ? "\r\n" : "\n"}`);
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
      await startProcessTree();
      await new Promise<never>(() => {});
    }
    const title = mode === "split-utf8" ? "日本語タイトル" : "helper-title";
    const response = Buffer.from(JSON.stringify({ id: 2, result: { thread: { name: title } } }));
    if (mode === "eof-no-newline") {
      await writeOutput(response);
      process.exit(0);
    }
    if (mode === "split-utf8") {
      const firstMultibyte = response.findIndex((byte) => byte >= 0x80);
      await writeOutput(response.subarray(0, firstMultibyte + 1));
      await Bun.sleep(5);
      await writeOutput(Buffer.concat([response.subarray(firstMultibyte + 1), Buffer.from("\n")]));
      return;
    }
    process.stdout.write(`${response.toString("utf8")}${mode === "crlf" ? "\r\n" : "\n"}`);
  }
}

if (targetHandled) process.exit(0);

async function startProcessTree(): Promise<void> {
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
}

async function writeOutput(value: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(value, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

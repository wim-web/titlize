import { AppServerClient, StdioAppServerTransportFactory } from "../../src/app-server-client";

const [helperPath, pidFile] = Bun.argv.slice(2);
if (!helperPath || !pidFile) process.exit(2);

const client = new AppServerClient({
  timeoutMs: 20_000,
  transportFactory: new StdioAppServerTransportFactory({
    command: process.execPath,
    args: [helperPath, "timeout-tree", pidFile],
  }),
});

try {
  await client.call("thread/read", { threadId: "session-1", includeTurns: false });
} catch {
  // The parent test sends SIGTERM while this call is active.
}

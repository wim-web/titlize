import { existsSync, writeFileSync } from "node:fs";
import { StateStore } from "../../src/state-store";

const [path, sessionId, turnId, gatePath, readyPath] = Bun.argv.slice(2);
if (!path || !sessionId || !turnId || !gatePath || !readyPath) {
  throw new Error("Expected database, session, turn, gate, and ready paths");
}

writeFileSync(readyPath, "ready");
while (!existsSync(gatePath)) await Bun.sleep(5);

const store = new StateStore(path);
try {
  process.stdout.write(JSON.stringify(store.recordStop(sessionId, turnId, "worker-now")));
} finally {
  store.close();
}

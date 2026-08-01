import {
  AppServerError,
  validateAppServerTitle,
  validateThreadId,
  type AppServerRpcClient,
} from "./app-server-client";
import { normalizeThreadMessages } from "./transcript-reader";
import type { NormalizedMessage } from "./types";

export class AppServerTitleSink {
  constructor(private readonly client: AppServerRpcClient) {}

  async readTitle(sessionId: string): Promise<string | undefined> {
    try {
      const threadId = validateThreadId(sessionId);
      const result = await this.client.call("thread/read", { threadId, includeTurns: false });
      const thread = readThread(result);
      if (
        Object.hasOwn(thread, "name") &&
        typeof thread.name !== "string" &&
        thread.name !== null
      ) {
        throw AppServerError.protocolError();
      }
      return typeof thread.name === "string" ? thread.name : undefined;
    } catch (error) {
      throw safeSinkError(error);
    }
  }

  async readConversation(sessionId: string): Promise<NormalizedMessage[]> {
    try {
      const threadId = validateThreadId(sessionId);
      const result = await this.client.call("thread/read", { threadId, includeTurns: true });
      return normalizeThreadMessages(readThread(result));
    } catch (error) {
      throw safeSinkError(error);
    }
  }

  async setTitle(sessionId: string, title: string): Promise<void> {
    try {
      const threadId = validateThreadId(sessionId);
      const name = validateAppServerTitle(title);
      const result = await this.client.call("thread/name/set", { threadId, name });
      if (!isPlainRecord(result)) throw AppServerError.protocolError();
    } catch (error) {
      throw safeSinkError(error);
    }
  }
}

function readThread(result: unknown): Record<string, unknown> {
  if (!isPlainRecord(result) || !Object.hasOwn(result, "thread") || !isPlainRecord(result.thread)) {
    throw AppServerError.protocolError();
  }
  return result.thread;
}

function safeSinkError(error: unknown): AppServerError {
  return error instanceof AppServerError ? error : AppServerError.protocolError();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

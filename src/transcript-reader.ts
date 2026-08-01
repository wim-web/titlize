import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { NormalizedMessage } from "./types";

const ERROR_MESSAGE = "Unable to read transcript.";

export class TranscriptError extends Error {
  constructor() {
    super(ERROR_MESSAGE);
    this.name = "TranscriptError";
  }
}

export class TranscriptReader {
  async read(path: string): Promise<NormalizedMessage[]> {
    const messages: NormalizedMessage[] = [];

    try {
      const lines = createInterface({
        input: createReadStream(path, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });

      for await (const line of lines) {
        const record = parseJson(line);
        const message = normalizeRolloutRecord(record);
        if (message) messages.push(message);
      }
    } catch {
      throw new TranscriptError();
    }

    if (messages.length === 0) throw new TranscriptError();
    return messages;
  }
}

export function normalizeThreadMessages(thread: unknown): NormalizedMessage[] {
  const root = asObject(thread);
  const turns = root && Array.isArray(root.turns) ? root.turns : null;
  if (!turns) throw new TranscriptError();

  const messages: NormalizedMessage[] = [];
  for (const turn of turns) {
    const turnObject = asObject(turn);
    if (!turnObject || !Array.isArray(turnObject.items)) continue;

    for (const item of turnObject.items) {
      const message = normalizeThreadItem(item);
      if (message) messages.push(message);
    }
  }

  if (messages.length === 0) throw new TranscriptError();
  return messages;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

function normalizeRolloutRecord(record: unknown): NormalizedMessage | null {
  const outer = asObject(record);
  if (!outer || outer.type !== "response_item") return null;

  const payload = asObject(outer.payload);
  if (!payload || payload.type !== "message") return null;

  const role = payload.role;
  if (role === "user") {
    return textMessage("user", payload.content, new Set(["input_text", "text"]));
  }
  if (role === "assistant" && isFinalPhase(payload.phase)) {
    return textMessage("assistant", payload.content, new Set(["output_text", "text"]));
  }
  return null;
}

function normalizeThreadItem(item: unknown): NormalizedMessage | null {
  const value = asObject(item);
  if (!value) return null;

  if (value.type === "userMessage") {
    return textMessage("user", value.content, new Set(["text"]));
  }
  if (value.type === "agentMessage" && isFinalPhase(value.phase) && typeof value.text === "string") {
    const content = value.text.trim();
    return content ? { role: "assistant", content } : null;
  }
  return null;
}

function textMessage(
  role: NormalizedMessage["role"],
  content: unknown,
  allowedTypes: Set<string>,
): NormalizedMessage | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    const value = asObject(part);
    if (
      value &&
      typeof value.type === "string" &&
      allowedTypes.has(value.type) &&
      typeof value.text === "string" &&
      value.text.trim()
    ) {
      parts.push(value.text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined ? { role, content: joined } : null;
}

function isFinalPhase(phase: unknown): boolean {
  return phase === "final_answer" || phase === null || phase === undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

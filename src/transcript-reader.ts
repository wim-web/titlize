import { createReadStream } from "node:fs";
import type { NormalizedMessage } from "./types";

const ERROR_MESSAGE = "Unable to read transcript.";
const MAX_JSONL_LINE_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
const MAX_NORMALIZED_MESSAGES = 1000;
const MAX_NORMALIZED_TEXT_CHARACTERS = 1_000_000;

export class TranscriptError extends Error {
  constructor() {
    super(ERROR_MESSAGE);
    this.name = "TranscriptError";
  }
}

export class TranscriptReader {
  async read(path: string): Promise<NormalizedMessage[]> {
    const messages: NormalizedMessage[] = [];
    let textCharacters = 0;

    try {
      for await (const line of readBoundedJsonlLines(path)) {
        const record = parseJson(line.toString("utf8"));
        const message = normalizeRolloutRecord(record);
        if (message) textCharacters = appendMessage(messages, message, textCharacters);
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
  let textCharacters = 0;
  for (const turn of turns) {
    const turnObject = asObject(turn);
    if (!turnObject || !Array.isArray(turnObject.items)) continue;

    for (const item of turnObject.items) {
      const message = normalizeThreadItem(item);
      if (message) textCharacters = appendMessage(messages, message, textCharacters);
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
    const content = normalizeText(value.text);
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
  let textCharacters = 0;
  for (const part of content) {
    const value = asObject(part);
    if (
      value &&
      typeof value.type === "string" &&
      allowedTypes.has(value.type) &&
      typeof value.text === "string" &&
      value.text.trim()
    ) {
      textCharacters += value.text.length + (parts.length > 0 ? 1 : 0);
      if (textCharacters > MAX_NORMALIZED_TEXT_CHARACTERS) throw new TranscriptError();
      parts.push(value.text);
    }
  }
  const joined = normalizeText(parts.join("\n"));
  return joined ? { role, content: joined } : null;
}

function normalizeText(text: string): string {
  const normalized = text.trim();
  if (normalized.length > MAX_NORMALIZED_TEXT_CHARACTERS) throw new TranscriptError();
  return normalized;
}

function appendMessage(
  messages: NormalizedMessage[],
  message: NormalizedMessage,
  textCharacters: number,
): number {
  if (messages.length >= MAX_NORMALIZED_MESSAGES) throw new TranscriptError();
  const nextTextCharacters = textCharacters + message.content.length;
  if (nextTextCharacters > MAX_NORMALIZED_TEXT_CHARACTERS) throw new TranscriptError();
  messages.push(message);
  return nextTextCharacters;
}

async function* readBoundedJsonlLines(path: string): AsyncGenerator<Buffer> {
  const stream = createReadStream(path);
  const parts: Buffer[] = [];
  let lineBytes = 0;
  let totalBytes = 0;

  const append = (part: Buffer): void => {
    lineBytes += part.length;
    // One trailing CR may still be removed when a following LF completes the line.
    if (lineBytes > MAX_JSONL_LINE_BYTES + 1) throw new TranscriptError();
    parts.push(part);
  };

  const takeLine = (): Buffer => {
    const line = Buffer.concat(parts, lineBytes);
    parts.length = 0;
    lineBytes = 0;
    const withoutCarriageReturn = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
    if (withoutCarriageReturn.length > MAX_JSONL_LINE_BYTES) throw new TranscriptError();
    return withoutCarriageReturn;
  };

  try {
    for await (const chunk of stream) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_TRANSCRIPT_BYTES) throw new TranscriptError();

      let start = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        append(chunk.subarray(start, index));
        yield takeLine();
        start = index + 1;
      }
      if (start < chunk.length) append(chunk.subarray(start));
    }
    if (lineBytes > 0) yield takeLine();
  } finally {
    stream.destroy();
  }
}

function isFinalPhase(phase: unknown): boolean {
  return phase === "final_answer" || phase === null || phase === undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

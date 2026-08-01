import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeThreadMessages,
  TranscriptError,
  TranscriptReader,
} from "../src/transcript-reader";

const fixturePath = join(import.meta.dir, "fixtures", "rollout.jsonl");

describe("TranscriptReader", () => {
  test("rollout JSONLからuserと最終assistant messageだけを順に抽出する", async () => {
    await expect(new TranscriptReader().read(fixturePath)).resolves.toEqual([
      { role: "user", content: "認証エラーを\n直して" },
      { role: "assistant", content: "認証処理を\n修正しました" },
      { role: "assistant", content: "追加で確認しました" },
    ]);
  });

  test("対応外のレコードだけなら安全なエラーにする", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "unsupported.jsonl");
      await Bun.write(path, '{"type":"response_item","payload":{"type":"reasoning"}}\n');
      await expect(new TranscriptReader().read(path)).rejects.toBeInstanceOf(TranscriptError);
    });
  });

  test("存在しないファイルのパスをエラーmessageに含めない", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "missing.jsonl");
      await expect(new TranscriptReader().read(path)).rejects.toMatchObject({
        name: "TranscriptError",
        message: "Unable to read transcript.",
      });
    });
  });

  test("有効message後の上限超過tool行を安全なエラーにする", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "oversized.jsonl");
      await Bun.write(
        path,
        `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "先に有効" }] } })}\n${JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(1024 * 1024 + 1) } })}\n`,
      );

      await expect(new TranscriptReader().read(path)).rejects.toBeInstanceOf(TranscriptError);
    });
  });

  test("CRLFとEOF終端なしの最終行を読む", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "crlf.jsonl");
      await Bun.write(
        path,
        `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "一行目" }] } })}\r\n${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "二行目" }] } })}`,
      );

      await expect(new TranscriptReader().read(path)).resolves.toEqual([
        { role: "user", content: "一行目" },
        { role: "assistant", content: "二行目" },
      ]);
    });
  });
});

describe("normalizeThreadMessages", () => {
  test("App Server threadを順に正規化しcommentaryとtoolを除外する", () => {
    const thread = {
      turns: [
        {
          items: [
            { type: "userMessage", content: [{ type: "text", text: "調べて" }, { type: "text", text: "ください" }] },
            { type: "agentMessage", phase: "commentary", text: "調査中" },
            { type: "commandExecution", command: "pwd" },
            { type: "agentMessage", phase: "final_answer", text: "確認しました" },
          ],
        },
        {
          items: [
            { type: "reasoning", text: "除外" },
            { type: "agentMessage", phase: null, text: "続けます" },
            { type: "agentMessage", text: "完了です" },
            { type: "hookPrompt", text: "除外" },
          ],
        },
      ],
    };

    expect(normalizeThreadMessages(thread)).toEqual([
      { role: "user", content: "調べて\nください" },
      { role: "assistant", content: "確認しました" },
      { role: "assistant", content: "続けます" },
      { role: "assistant", content: "完了です" },
    ]);
  });

  test("空または不正なshapeを安全なエラーにし入力を変更しない", () => {
    const thread = { turns: [{ items: [{ type: "userMessage", content: [{ type: "text", text: "  " }] }] }] };
    const original = structuredClone(thread);

    expect(() => normalizeThreadMessages(thread)).toThrow(TranscriptError);
    expect(() => normalizeThreadMessages({ turns: "invalid" })).toThrow(TranscriptError);
    expect(thread).toEqual(original);
  });

  test("App Serverのmessage数上限を超えると安全なエラーにする", () => {
    const thread = {
      turns: [{
        items: Array.from({ length: 1001 }, () => ({
          type: "agentMessage",
          phase: "final_answer",
          text: "応答",
        })),
      }],
    };

    expect(() => normalizeThreadMessages(thread)).toThrow(TranscriptError);
  });
});

async function withTemporaryDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "titlize-transcript-test-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

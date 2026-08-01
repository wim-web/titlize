import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
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
    const path = join(import.meta.dir, "fixtures", "unsupported.jsonl");
    await Bun.write(path, '{"type":"response_item","payload":{"type":"reasoning"}}\n');
    try {
      await expect(new TranscriptReader().read(path)).rejects.toBeInstanceOf(TranscriptError);
    } finally {
      await rm(path, { force: true });
    }
  });

  test("存在しないファイルのパスをエラーmessageに含めない", async () => {
    const path = "/tmp/secret-transcript-path.jsonl";
    await expect(new TranscriptReader().read(path)).rejects.toMatchObject({
      name: "TranscriptError",
      message: "Unable to read transcript.",
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
});

import { describe, expect, test } from "bun:test";
import { AppServerError, type AppServerRpcClient, type AppServerRpcMethod } from "../src/app-server-client";
import { AppServerTitleSink } from "../src/app-server-title-sink";

class FakeRpcClient implements AppServerRpcClient {
  readonly calls: Array<{ method: AppServerRpcMethod; params: unknown }> = [];

  constructor(private readonly results: unknown[]) {}

  async call(method: AppServerRpcMethod, params: unknown): Promise<unknown> {
    this.calls.push({ method, params: structuredClone(params) });
    if (this.results.length === 0) throw new Error("missing fake result");
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    return result;
  }
}

describe("AppServerTitleSink", () => {
  test.each([
    ["string", "旧タイトル", "旧タイトル"],
    ["null", null, undefined],
  ] as const)("readTitleはthread/readのname %sを返す", async (_name, value, expected) => {
    const client = new FakeRpcClient([{ thread: { id: "s1", name: value, turns: [] } }]);
    const sink = new AppServerTitleSink(client);

    await expect(sink.readTitle("s1")).resolves.toBe(expected);
    expect(client.calls).toEqual([
      { method: "thread/read", params: { threadId: "s1", includeTurns: false } },
    ]);
  });

  test("readConversationはincludeTurns:trueのthreadを正規化する", async () => {
    const thread = {
      id: "s1",
      name: "現在名",
      turns: [
        {
          items: [
            { type: "userMessage", content: [{ type: "text", text: "認証エラーを直して" }] },
            { type: "reasoning", summary: ["secret reasoning"] },
            { type: "agentMessage", phase: "commentary", text: "調査中" },
            { type: "agentMessage", phase: "final_answer", text: "修正しました" },
          ],
        },
      ],
    };
    const original = structuredClone(thread);
    const client = new FakeRpcClient([{ thread }]);
    const sink = new AppServerTitleSink(client);

    await expect(sink.readConversation("s1")).resolves.toEqual([
      { role: "user", content: "認証エラーを直して" },
      { role: "assistant", content: "修正しました" },
    ]);
    expect(client.calls).toEqual([
      { method: "thread/read", params: { threadId: "s1", includeTurns: true } },
    ]);
    expect(thread).toEqual(original);
  });

  test("setTitleはthread/name/setへ正確なparamsを渡す", async () => {
    const client = new FakeRpcClient([{}]);
    const sink = new AppServerTitleSink(client);

    await expect(sink.setTitle("s1", "新タイトル")).resolves.toBeUndefined();
    expect(client.calls).toEqual([
      { method: "thread/name/set", params: { threadId: "s1", name: "新タイトル" } },
    ]);
  });

  test.each([
    ["missing response", {}],
    ["missing thread", { other: {} }],
    ["non-object thread", { thread: "response-secret" }],
    ["missing name", { thread: { turns: [] } }],
    ["invalid name", { thread: { name: 42, turns: [] } }],
  ])("readTitleの壊れたschemaを安全に拒否する: %s", async (_name, result) => {
    const sink = new AppServerTitleSink(new FakeRpcClient([result]));

    const rejection = sink.readTitle("s1");
    await expect(rejection).rejects.toBeInstanceOf(AppServerError);
    await expect(rejection).rejects.toThrow("app server returned an invalid response");
    await expect(rejection).rejects.not.toThrow(/response-secret/);
  });

  test.each([
    ["missing response", {}],
    ["invalid turns", { thread: { name: null, turns: "response-secret" } }],
    ["empty turns", { thread: { name: null, turns: [] } }],
  ])("readConversationの壊れたschemaを安全に拒否する: %s", async (_name, result) => {
    const sink = new AppServerTitleSink(new FakeRpcClient([result]));

    const rejection = sink.readConversation("s1");
    await expect(rejection).rejects.toBeInstanceOf(AppServerError);
    await expect(rejection).rejects.not.toThrow(/response-secret|TranscriptError/);
  });

  test.each([
    ["readTitle", () => new AppServerTitleSink(new FakeRpcClient([])).readTitle("bad\0secret")],
    ["readConversation", () => new AppServerTitleSink(new FakeRpcClient([])).readConversation("")],
    ["setTitle", () => new AppServerTitleSink(new FakeRpcClient([])).setTitle("s1", "")],
  ] as const)("%sは不正入力をclient呼び出し前に拒否する", async (_name, call) => {
    const rejection = call();
    await expect(rejection).rejects.toBeInstanceOf(AppServerError);
    await expect(rejection).rejects.not.toThrow(/secret/);
  });

  test("clientのAppServerErrorを分類を保ったまま伝播する", async () => {
    const expected = AppServerError.timedOut();
    const sink = new AppServerTitleSink(new FakeRpcClient([expected]));

    await expect(sink.readTitle("s1")).rejects.toBe(expected);
  });

  test("setTitle responseがobjectでなければ安全に拒否する", async () => {
    const sink = new AppServerTitleSink(new FakeRpcClient(["response-secret"]));

    const rejection = sink.setTitle("s1", "新タイトル");
    await expect(rejection).rejects.toBeInstanceOf(AppServerError);
    await expect(rejection).rejects.not.toThrow(/response-secret/);
  });
});

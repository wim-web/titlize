import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("環境変数がない場合は既定値を返す", () => {
    expect(loadConfig({})).toEqual({
      every: 3,
      maxChars: 40,
      statePath: join(process.env.HOME ?? "", ".codex", "codex-title", "state.sqlite3"),
    });
  });

  test("明示された環境変数で既定値を上書きする", () => {
    expect(
      loadConfig({
        CODEX_TITLE_EVERY: "7",
        CODEX_TITLE_MAX_CHARS: "32",
        CODEX_TITLE_STATE_PATH: "/tmp/custom.sqlite3",
      }),
    ).toEqual({
      every: 7,
      maxChars: 32,
      statePath: "/tmp/custom.sqlite3",
    });
  });

  test("CODEX_HOMEを状態パスのフォールバックに使う", () => {
    expect(loadConfig({ CODEX_HOME: "/tmp/codex-home" }).statePath).toBe(
      "/tmp/codex-home/codex-title/state.sqlite3",
    );
  });

  test.each([
    ["CODEX_TITLE_EVERY", "every"],
    ["CODEX_TITLE_MAX_CHARS", "maxChars"],
  ] as const)("%sは安全な最大整数を受け入れる", (name, property) => {
    expect(loadConfig({ [name]: "9007199254740991" })[property]).toBe(
      9007199254740991,
    );
  });

  test.each(["CODEX_TITLE_EVERY", "CODEX_TITLE_MAX_CHARS"] as const)(
    "%sは正の10進安全整数だけを受け入れる",
    (name) => {
      for (const value of [
        "",
        "0",
        "-1",
        "1.5",
        "3x",
        "Infinity",
        "9007199254740992",
        "999999999999999999999999999999999999",
        " 3",
        "3 ",
      ]) {
        expect(() => loadConfig({ [name]: value })).toThrow(name);
      }
    },
  );

  test.each(["", "   "])("空の状態パスを拒否する: %j", (value) => {
    expect(() => loadConfig({ CODEX_TITLE_STATE_PATH: value })).toThrow(
      "CODEX_TITLE_STATE_PATH",
    );
  });

  test("状態パスは値をトリムせず保持する", () => {
    expect(loadConfig({ CODEX_TITLE_STATE_PATH: " /tmp/state " }).statePath).toBe(
      " /tmp/state ",
    );
  });
});

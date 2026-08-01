import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("環境変数がない場合は既定値を返す", () => {
    expect(loadConfig({})).toEqual({
      every: 3,
      provider: "codex",
      model: "gpt-5.6-luna",
      maxChars: 40,
      timeoutMs: 30000,
      statePath: join(homedir(), ".codex", "codex-title", "state.sqlite3"),
      appServer: "stdio://",
    });
  });

  test("明示された環境変数で既定値を上書きする", () => {
    expect(
      loadConfig({
        CODEX_TITLE_EVERY: "4",
        CODEX_TITLE_PROVIDER: "codex",
        CODEX_TITLE_MODEL: "custom-model",
        CODEX_TITLE_MAX_CHARS: "64",
        CODEX_TITLE_TIMEOUT_MS: "5000",
        CODEX_TITLE_STATE_PATH: "/tmp/title-state.sqlite3",
        CODEX_TITLE_APP_SERVER: "stdio://",
      }),
    ).toEqual({
      every: 4,
      provider: "codex",
      model: "custom-model",
      maxChars: 64,
      timeoutMs: 5000,
      statePath: "/tmp/title-state.sqlite3",
      appServer: "stdio://",
    });
  });

  test("CODEX_HOME を状態パスのフォールバックに使う", () => {
    expect(loadConfig({ CODEX_HOME: "/tmp/codex-home" }).statePath).toBe(
      "/tmp/codex-home/codex-title/state.sqlite3",
    );
  });

  test.each([
    ["CODEX_TITLE_EVERY", ""],
    ["CODEX_TITLE_EVERY", "0"],
    ["CODEX_TITLE_EVERY", "-1"],
    ["CODEX_TITLE_EVERY", "1.5"],
    ["CODEX_TITLE_EVERY", "3x"],
    ["CODEX_TITLE_EVERY", "Infinity"],
    ["CODEX_TITLE_EVERY", "999999999999999999999999999999999999999999999999999"],
    ["CODEX_TITLE_EVERY", " 3"],
    ["CODEX_TITLE_EVERY", "3 "],
    ["CODEX_TITLE_MAX_CHARS", ""],
    ["CODEX_TITLE_MAX_CHARS", "0"],
    ["CODEX_TITLE_MAX_CHARS", "-1"],
    ["CODEX_TITLE_MAX_CHARS", "1.5"],
    ["CODEX_TITLE_MAX_CHARS", "3x"],
    ["CODEX_TITLE_MAX_CHARS", "Infinity"],
    ["CODEX_TITLE_MAX_CHARS", "999999999999999999999999999999999999999999999999999"],
    ["CODEX_TITLE_MAX_CHARS", " 3"],
    ["CODEX_TITLE_MAX_CHARS", "3 "],
    ["CODEX_TITLE_TIMEOUT_MS", ""],
    ["CODEX_TITLE_TIMEOUT_MS", "0"],
    ["CODEX_TITLE_TIMEOUT_MS", "-1"],
    ["CODEX_TITLE_TIMEOUT_MS", "1.5"],
    ["CODEX_TITLE_TIMEOUT_MS", "3x"],
    ["CODEX_TITLE_TIMEOUT_MS", "Infinity"],
    ["CODEX_TITLE_TIMEOUT_MS", "999999999999999999999999999999999999999999999999999"],
    ["CODEX_TITLE_TIMEOUT_MS", " 3"],
    ["CODEX_TITLE_TIMEOUT_MS", "3 "],
  ])("%s は正の10進整数だけを受け入れる: %s", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
  });

  test.each([
    ["CODEX_TITLE_PROVIDER", "other"],
    ["CODEX_TITLE_PROVIDER", ""],
    ["CODEX_TITLE_APP_SERVER", "ws://localhost"],
    ["CODEX_TITLE_APP_SERVER", ""],
    ["CODEX_TITLE_MODEL", ""],
    ["CODEX_TITLE_MODEL", "   "],
    ["CODEX_TITLE_STATE_PATH", ""],
    ["CODEX_TITLE_STATE_PATH", "   "],
  ])("%s の不正な値を拒否する", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
  });

  test("モデル名と状態パスは値をトリムせず保持する", () => {
    expect(
      loadConfig({
        CODEX_TITLE_MODEL: " model-with-spaces ",
        CODEX_TITLE_STATE_PATH: " /tmp/state.sqlite3 ",
      }),
    ).toMatchObject({
      model: " model-with-spaces ",
      statePath: " /tmp/state.sqlite3 ",
    });
  });
});

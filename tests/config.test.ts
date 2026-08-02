import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveConfigPath } from "../src/config";

function loadWithoutFile(
  env: Record<string, string | undefined> = {},
) {
  return loadConfig(env, { readFile: () => undefined });
}

function loadWithFile(
  file: Record<string, unknown> | string,
  env: Record<string, string | undefined> = {},
) {
  return loadConfig(env, {
    readFile: () => typeof file === "string" ? file : JSON.stringify(file),
  });
}

describe("loadConfig", () => {
  test("環境変数がない場合は既定値を返す", () => {
    expect(loadWithoutFile()).toEqual({
      every: 3,
      maxChars: 40,
      statePath: join(homedir(), ".codex", "codex-title", "state.sqlite3"),
    });
  });

  test("CODEX_HOME配下のtitlize.jsonを読み込む", () => {
    const paths: string[] = [];
    expect(
      loadConfig(
        { CODEX_HOME: "/tmp/codex-home" },
        {
          readFile(path) {
            paths.push(path);
            return JSON.stringify({
              every: 5,
              maxChars: 28,
              statePath: "/tmp/from-config.sqlite3",
            });
          },
        },
      ),
    ).toEqual({
      every: 5,
      maxChars: 28,
      statePath: "/tmp/from-config.sqlite3",
    });
    expect(paths).toEqual(["/tmp/codex-home/titlize.json"]);
  });

  test("CODEX_TITLE_CONFIG_PATHで設定ファイルの場所を上書きする", () => {
    const paths: string[] = [];
    loadConfig(
      {
        CODEX_HOME: "/tmp/codex-home",
        CODEX_TITLE_CONFIG_PATH: "/tmp/custom-config.json",
      },
      {
        readFile(path) {
          paths.push(path);
          return undefined;
        },
      },
    );
    expect(paths).toEqual(["/tmp/custom-config.json"]);
  });

  test("環境変数は設定ファイルより優先される", () => {
    expect(
      loadWithFile(
        {
          every: 5,
          maxChars: 28,
          statePath: "/tmp/from-config.sqlite3",
        },
        {
          CODEX_TITLE_EVERY: "7",
          CODEX_TITLE_MAX_CHARS: "32",
          CODEX_TITLE_STATE_PATH: "/tmp/from-env.sqlite3",
        },
      ),
    ).toEqual({
      every: 7,
      maxChars: 32,
      statePath: "/tmp/from-env.sqlite3",
    });
  });

  test("明示された環境変数で既定値を上書きする", () => {
    expect(
      loadWithoutFile({
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
    expect(loadWithoutFile({ CODEX_HOME: "/tmp/codex-home" }).statePath).toBe(
      "/tmp/codex-home/codex-title/state.sqlite3",
    );
  });

  test.each([
    ["CODEX_TITLE_EVERY", "every"],
    ["CODEX_TITLE_MAX_CHARS", "maxChars"],
  ] as const)("%sは安全な最大整数を受け入れる", (name, property) => {
    expect(loadWithoutFile({ [name]: "9007199254740991" })[property]).toBe(
      9007199254740991,
    );
  });

  test("設定ファイルは安全な最大整数を受け入れる", () => {
    expect(loadWithFile({ every: 9007199254740991 }).every).toBe(
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
        expect(() => loadWithoutFile({ [name]: value })).toThrow(name);
      }
    },
  );

  test.each([
    ["every", 0],
    ["every", -1],
    ["every", 1.5],
    ["every", "3"],
    ["maxChars", 9007199254740992],
    ["maxChars", null],
  ])("設定ファイルの不正値を拒否する: %s=%j", (name, value) => {
    expect(() => loadWithFile({ [name]: value })).toThrow(`config ${name}`);
  });

  test.each([
    ["不正JSON", "{"],
    ["配列", "[]"],
    ["null", "null"],
    ["未知キー", JSON.stringify({ evry: 3 })],
  ])("不正な設定ファイルを拒否する: %s", (_name, contents) => {
    expect(() => loadWithFile(contents)).toThrow();
  });

  test.each(["", "   "])("空の状態パスを拒否する: %j", (value) => {
    expect(() => loadWithoutFile({ CODEX_TITLE_STATE_PATH: value })).toThrow(
      "CODEX_TITLE_STATE_PATH",
    );
  });

  test.each(["", "   "])("設定ファイルの空の状態パスを拒否する: %j", (value) => {
    expect(() => loadWithFile({ statePath: value })).toThrow("config statePath");
  });

  test("状態パスは値をトリムせず保持する", () => {
    expect(loadWithoutFile({ CODEX_TITLE_STATE_PATH: " /tmp/state " }).statePath).toBe(
      " /tmp/state ",
    );
    expect(loadWithFile({ statePath: " /tmp/from-file " }).statePath).toBe(
      " /tmp/from-file ",
    );
  });

  test("空の設定ファイルパスを拒否する", () => {
    expect(() => loadWithoutFile({ CODEX_TITLE_CONFIG_PATH: " " })).toThrow(
      "CODEX_TITLE_CONFIG_PATH",
    );
  });

  test("既定の設定ファイルパスを返す", () => {
    expect(resolveConfigPath({})).toBe(join(homedir(), ".codex", "titlize.json"));
  });
});

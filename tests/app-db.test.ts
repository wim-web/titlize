import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppDbTitleReader,
  MAX_APP_TITLE_CODE_UNITS,
  resolveAppStatePath,
} from "../src/app-db";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "titlize-app-db-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function createAppDatabase(path: string, rows: Array<{ id: string; title: unknown }>): void {
  const db = new Database(path);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)");
    for (const row of rows) {
      db.query("INSERT INTO threads (id, title) VALUES (?, ?)").run(row.id, row.title as string);
    }
  } finally {
    db.close();
  }
}

describe("resolveAppStatePath", () => {
  test("最も新しいバージョンの state_N.sqlite を選ぶ", () => {
    const home = temporaryDirectory();
    for (const name of ["state_4.sqlite", "state_5.sqlite", "state_10.sqlite"]) {
      writeFileSync(join(home, name), "");
    }
    writeFileSync(join(home, "state_5.sqlite-wal"), "");
    writeFileSync(join(home, "state.sqlite"), "");

    expect(resolveAppStatePath(home)).toBe(join(home, "state_10.sqlite"));
  });

  test("候補がなければ undefined、override 指定はそのまま返す", () => {
    const home = temporaryDirectory();
    expect(resolveAppStatePath(home)).toBeUndefined();
    expect(resolveAppStatePath("/missing-codex-home")).toBeUndefined();
    expect(resolveAppStatePath(home, "/tmp/custom.sqlite")).toBe("/tmp/custom.sqlite");
  });
});

describe("AppDbTitleReader", () => {
  test("threads テーブルから現在タイトルを読む", () => {
    const home = temporaryDirectory();
    const path = join(home, "state_5.sqlite");
    createAppDatabase(path, [
      { id: "thread-a", title: "タイトルA" },
      { id: "thread-b", title: "" },
    ]);
    const reader = new AppDbTitleReader(path);

    expect(reader.readCurrentTitle("thread-a")).toEqual({ ok: true, title: "タイトルA" });
    expect(reader.readCurrentTitle("thread-b")).toEqual({ ok: true, title: "" });
  });

  test("行なし・DBなし・path未解決は ok:false を返す", () => {
    const home = temporaryDirectory();
    const path = join(home, "state_5.sqlite");
    createAppDatabase(path, []);

    expect(new AppDbTitleReader(path).readCurrentTitle("missing")).toEqual({ ok: false });
    expect(new AppDbTitleReader(join(home, "absent.sqlite")).readCurrentTitle("x")).toEqual({ ok: false });
    expect(new AppDbTitleReader(undefined).readCurrentTitle("x")).toEqual({ ok: false });
  });

  test("スキーマが想定と異なる場合は ok:false を返す", () => {
    const home = temporaryDirectory();
    const path = join(home, "state_6.sqlite");
    const db = new Database(path);
    db.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY, name TEXT)");
    db.close();

    expect(new AppDbTitleReader(path).readCurrentTitle("x")).toEqual({ ok: false });
  });

  test("読取り専用で開きDBを変更しない", () => {
    const home = temporaryDirectory();
    const path = join(home, "state_5.sqlite");
    createAppDatabase(path, [{ id: "thread-a", title: "タイトルA" }]);

    new AppDbTitleReader(path).readCurrentTitle("thread-a");

    const db = new Database(path, { readonly: true });
    try {
      expect(
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM threads").get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  test("過大なタイトルは ok:false を返す", () => {
    const home = temporaryDirectory();
    const path = join(home, "state_5.sqlite");
    createAppDatabase(path, [
      { id: "thread-long", title: "あ".repeat(MAX_APP_TITLE_CODE_UNITS + 1) },
    ]);

    expect(new AppDbTitleReader(path).readCurrentTitle("thread-long")).toEqual({ ok: false });
  });
});

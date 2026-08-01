# titlize

Codexの同期`Stop` Hookから、セッションごとの一定回数ごとに会話を要約し、Codex App Server経由でタスク名を更新するBun + TypeScript CLIです。タイトル生成には一時的な子Codexを使います。ユーザー共通Hookとしてインストールするため、Codexで開くすべてのプロジェクトに適用されます。初版は単発CLIとして実装し、常駐デーモンやPlugin/Skill化は含みません。

## 動作の流れ

```text
Stop Hook
  → HookController（入力検証・重複排除・周期判定）
  → SQLite StateStore（pendingを先に保存）
  → TranscriptReader（userと最終assistantだけを抽出）
  → CodexTitleProvider（ephemeralな子Codex）
  → TitleValidator（日本語1行・最大長）
  → AppServerTitleSink（thread/read・thread/name/set）
  → SQLite StateStore（成功または再試行状態を保存）
```

Hookは同期実行です。更新対象の`Stop`では、タイトル生成とApp Server更新が終わるまでHookが完了しません。通常更新の内部処理は最大でApp Server RPC 3回と子Codex 1回を順に行い、各操作の設定上限は30秒です。インストーラーが`~/.codex/hooks.json`へ登録するHookは、その合計120秒にcleanup用30秒を加えた150秒をcommand Hookの上限にしています。Transcriptファイル自体のI/OやOS schedulingまでこの計算で保証するものではありません。

## セットアップ

Bun 1.3系と、通常利用できる状態のCodex CLIが必要です。

```bash
bun install
bun test
bun run typecheck
bun run install:user
```

`install:user`は通常bundleを作り、次の場所へインストールします。

```text
${CODEX_HOME:-~/.codex}/titlize/codex-title
${CODEX_HOME:-~/.codex}/hooks.json
```

既存のユーザーHookは保持し、titlizeの`Stop` Hookだけを追加または更新します。Hookはインストール時に検出したBunの絶対パスと、インストール済みbundleの絶対パスを使うため、起動中のプロジェクトやGit rootには依存しません。

インストール後にCodexで`/hooks`を実行し、内容を確認して`titlize: タスク名を更新しています`というHookを信頼してください。一度だけ試す場合はCodex起動時の`--dangerously-bypass-hook-trust`も利用できます。ユーザー共通Hookなので、その後はどのプロジェクトをCodexで開いても動作します。

コード更新後は`bun run install:user`を再実行するとbundleとHookを更新します。削除するときは次を実行します。既存の他のユーザーHookは削除しません。

```bash
bun run uninstall:user
```

同梱インストーラーの対応環境はmacOS/Linuxです。WindowsではHook commandとインストールパスを対象環境に合わせる必要があります。

## CLI

開発中はTypeScriptを直接実行します。

```bash
bun src/cli.ts hook
bun src/cli.ts update --session-id <session-id> --force
bun src/cli.ts update --session-id <session-id> --transcript-path /absolute/path/to/rollout.jsonl --force
```

`update --force`はStop回数を増やさず、手動変更による自動更新停止を意図的に上書きして解除します。`--transcript-path`を省略すると、App Serverの`thread/read(includeTurns: true)`から会話を取得します。相対パス、空のsession ID、未知・重複・不足したflagは拒否します。

通常のbundleは次で作成し、Bunから実行できます。

```bash
bun run build
bun dist/codex-title update --session-id <session-id> --force
```

Bunランタイム込みの単一実行ファイルが必要な場合は、将来の配布形態と同じく`--compile`を使います。`install:user`はBunで実行する通常bundleを使うため、この手順は必須ではありません。macOSではcompile時または配布時のcode signingが実行環境固有の工程になることがあり、このリポジトリは署名identityや配布用署名を設定しません。Bun 1.3.12のcompileがローカルの署名環境で失敗する場合は、通常bundleを使うか、配布環境側で署名工程を構成してください。

```bash
bun build --compile --outfile=dist/codex-title-bin src/cli.ts
./dist/codex-title-bin update --session-id <session-id> --force
```

## 設定

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `CODEX_TITLE_EVERY` | `3` | セッションごとに何回目の新しい`Stop`で更新するか |
| `CODEX_TITLE_PROVIDER` | `codex` | 初版で対応するProvider。`codex`のみ |
| `CODEX_TITLE_MODEL` | `gpt-5.6-luna` | タイトル生成に使うCodexモデル |
| `CODEX_TITLE_MAX_CHARS` | `40` | タイトルの最大Unicodeコードポイント数 |
| `CODEX_TITLE_TIMEOUT_MS` | `30000` | 子Codexと各App Server RPCのタイムアウト（1〜30000ミリ秒） |
| `CODEX_TITLE_STATE_PATH` | `${CODEX_HOME:-~/.codex}/codex-title/state.sqlite3` | SQLite状態ファイル |
| `CODEX_TITLE_APP_SERVER` | `stdio://` | App Server transport。初版は`stdio://`のみ |

整数設定は正の10進整数だけを受け入れ、`CODEX_TITLE_TIMEOUT_MS`は最大30000に制限します。通常Hookの最悪構成はこの上限の4倍なので、インストーラーが生成するHookは150秒に固定しています。コード側の上限を変更する場合は、4倍の内部処理枠とcleanup余裕を保つようHook timeoutも同時に変更してください。Providerやtransportを含む不正な設定は、状態DBを開く前にHook更新をスキップします。

## 更新周期、再試行、手動タイトル保護

`session_id`ごとに状態を分離し、`(session_id, turn_id)`を処理済みテーブルへ保存します。同じturnは一度しか数えません。通常の更新条件は次のとおりです。

```text
stop_count % CODEX_TITLE_EVERY == 0
または
pending_update == true
```

更新を開始する前に`pending_update = 1`を保存します。Transcript、生成、検証、App Serverのどこで失敗してもpendingを残し、次の異なる`Stop`で周期外でも再試行します。通常Hookで公式入力の`transcript_path`が`null`の場合、App Server履歴へ自動フォールバックはせずpendingを残します。次の`Stop`で有効なパスが渡されれば再試行します。App Server履歴を使うのは、Transcriptを省略した`update --force`だけです。

前回の自動タイトル`last_auto_title`と現在名が違えば、ユーザーの手動変更と判断し、そのセッションを`auto_update_disabled = 1`にします。また、タイトル生成の直後にも現在名を読み直します。生成中に名前が変わっていれば書き込まず、手動変更として停止します。

App Serverへ書く直前には、生成候補`pending_title`、書込み前の名前`pending_previous_title`、その値が既知かを示す`pending_previous_title_known`をSQLiteへ先に保存します。これにより、App Serverでの書込み成功後に応答やSQLite成功記録だけが失われても、次回は次のように回復できます。

- 現在名が候補と同じ: 適用済みとして成功を記録する。
- 現在名が書込み前名と同じ: 未適用としてintentを消し、安全に再試行する。
- どちらとも違う: 手動変更として自動更新を停止する。

## SQLite状態

`sessions`には次の列があります。

```text
session_id                     TEXT PRIMARY KEY
stop_count                     INTEGER NOT NULL
last_turn_id                   TEXT
pending_update                 INTEGER NOT NULL
last_auto_title                TEXT
pending_title                  TEXT
pending_previous_title         TEXT
pending_previous_title_known   INTEGER NOT NULL
auto_update_disabled           INTEGER NOT NULL
last_success_at                TEXT
updated_at                     TEXT NOT NULL
```

重複排除用に`processed_turns(session_id, turn_id)`も保持します。古いDBに書込みintent列がない場合は起動時に追加します。候補だけが残る旧形式では、`last_auto_title`から書込み前名を安全に復元できる場合だけ自動再試行し、復元できない初回intentは手動タイトルを上書きしないよう保守的に停止します。

## 子Codexの分離と認証

タイトル生成子は`codex exec --ephemeral`で実行するため、サイドバーへ余分なタスクを残しません。再帰防止は二重です。

- 子Codexを`--disable hooks`で起動する。
- 子環境へ`CODEX_TITLE_CHILD=1`を渡し、CLIとHookControllerの両方で即終了する。

さらに、子は空の一時作業ディレクトリ、read-only sandbox、`--ignore-user-config`、`--ignore-rules`で起動します。shell tool、remote plugin、apps、plugins、web search、subagent、画像toolを無効化し、approvalを`never`に固定します。Transcript内の命令を上位指示として扱わず、stdoutのタイトル候補だけを受け取ります。

認証は通常のCodexログインで作られる`${CODEX_HOME:-~/.codex}/auth.json`を使います。子環境は`HOME`、`CODEX_HOME`などの必要最小限のallowlistだけを引き継ぎ、API keyや任意のsecret環境変数は渡しません。そのため初版は、環境変数のAPI keyを必要とする独自Providerや独自Codex endpointには対応しません。

## 出力、プライバシー、エラー

`hook`は入力不正、設定不正、SQLite失敗、Transcript失敗、LLM失敗・タイムアウト、App Server失敗を含むすべての処理経路で、stdoutへ`{}\n`をちょうど1回書き、終了コード0を返します。Codex本体のターンを妨げるJSONやログはstdoutへ出しません。stdout自体が書けない場合も例外は外へ伝播させませんが、同じ出力を再送すると重複の危険があるため再送はしません。

stderrには`hook_input_invalid`、`title_update_failed`のような固定分類だけを出します。Hook JSON、Transcript本文・パス、生成タイトル、プロンプト、子Codex/App Serverの生stderr、環境変数、stack traceは出しません。SQLiteは構築後のすべての経路でcloseを試みます。

一方、明示操作の`update --force`は失敗を隠さず、stdoutは空のまま固定stderr分類を出して非0で終了します。

## テストと受け入れ確認

自動テスト、型検査、bundle作成を実行します。

```bash
bun test
bun run typecheck
bun run build
```

Hookのfail-open契約だけを手元で確認する例です。どちらもstdoutは`{}`だけ、終了コードは0です。

```bash
printf '%s\n' '{"hook_event_name":"SessionStart"}' | bun src/cli.ts hook
printf '%s\n' 'broken-input' | bun src/cli.ts hook
```

実Codexでの受け入れ確認は、先に`bun run install:user`を実行し、通常の状態DBと混ぜないよう一時パスで行います。ユーザー共通Hookなので、任意のプロジェクトから実行できます。

```bash
export CODEX_TITLE_EVERY=1
export CODEX_TITLE_STATE_PATH="$(mktemp -d)/state.sqlite3"
codex --dangerously-bypass-hook-trust
```

起動したCodexで次を確認します。

1. 新しいテストタスクで1ターン実行し、サイドバー名が会話内容に合う日本語へ変わる。
2. 履歴に増えたタスクが親テストタスク1件だけで、タイトル生成用の余計なタスクがない。
3. 1回のStopで再帰更新が起きず、SQLiteの対象行が`stop_count = 1`、`pending_update = 0`になる。
4. 別のテストタスクを1ターン実行し、SQLiteに別`session_id`の`stop_count = 1`が作られ、最初の行と混ざらない。
5. 最初のタスク名を手動変更してもう1ターン実行し、手動名が維持され、対象行が`auto_update_disabled = 1`になる。

状態はBunから読み取り専用で確認できます。

```bash
bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.env.CODEX_TITLE_STATE_PATH, { readonly: true }); console.table(db.query("SELECT session_id, stop_count, pending_update, last_auto_title, auto_update_disabled FROM sessions ORDER BY updated_at").all())'
```

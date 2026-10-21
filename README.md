# titlize

Codex Appのタスク名を、一定ターンごとに自動更新するユーザー共通Hookです。

タイトルの書込みにはCodex App内蔵の`codex_app__set_thread_title`を、現在タイトルの確認にはCodex Appの状態DB（`${CODEX_HOME:-~/.codex}/state_<N>.sqlite`）の読取り専用アクセスを使います。共有Server、常駐デーモン、LaunchAgent、タイトル生成用の別タスク、追加のモデル呼び出しは使いません。

## 動作

```text
Stop Hook            : session_idごとに回数を記録し、更新回ならpending_update = 1を保存（表示なし）
                       直前の注入で予約したリネームがあれば、アプリDBのタイトル変化を確認して採用
UserPromptSubmit Hook: pendingがあればアプリDBで現在タイトルを確認し、
                       前回の自動タイトルから手動変更されていれば自動更新を停止、
                       問題なければ現在タイトルを基準として保存してrename指示を注入
```

注入指示を受けたモデルは`codex_app__set_thread_title`を1回呼びます。書込みの成否はツールイベントではなく、次のHook実行時にアプリDBのタイトルが基準から変わったかどうかで検証します（Codex Appの`codex_app__*`ツールは`exec`ツール内のJSブリッジ経由で呼ばれるため、ツール名ベースのPreToolUse/PostToolUseでは捕捉できません）。

既定では3回目の新しい`Stop`ごとに更新を予約します。同じ`turn_id`の再送と、`stop_hook_active: true`の継続側`Stop`は数えません。注入できなかったpendingは以降のメッセージで再試行します。

## セットアップ

Bun 1.3系が必要です。

```bash
bun install
bun run install:user
```

`${TITLIZE_INSTALL_DIR:-~/.local/bin}/titlize`と`${CODEX_HOME:-~/.codex}/hooks.json`を更新し、未作成なら`${CODEX_HOME:-~/.codex}/titlize.json`を作成します。既存の他のHookと既存のtitlize設定は保持し、titlizeの`Stop`と`UserPromptSubmit`（合計2ハンドラ）だけを追加・更新します。旧バージョンが入れた`PreToolUse`/`PostToolUse`のtitlizeエントリは撤去します。

インストール後、Codexの`/hooks`でtitlizeのHook（2件）を信頼してください。信頼されていないHookは実行されません。

アンインストールは`bun run uninstall:user`です（他のHookは残します）。

## 設定

`${CODEX_HOME:-~/.codex}/titlize.json`を編集します。初回インストール時の内容は次のとおりです。

```json
{
  "every": 3,
  "maxChars": 40
}
```

| 設定キー | 環境変数での上書き | 既定値 | 説明 |
| --- | --- | --- | --- |
| `every` | `CODEX_TITLE_EVERY` | `3` | 何回目の通常`Stop`で更新を予約するか |
| `maxChars` | `CODEX_TITLE_MAX_CHARS` | `40` | タイトルの最大文字数 |
| `statePath` | `CODEX_TITLE_STATE_PATH` | `${CODEX_HOME:-~/.codex}/codex-title/state.sqlite3` | SQLite状態ファイル |
| `appStatePath` | `CODEX_TITLE_APP_STATE_PATH` | `${CODEX_HOME:-~/.codex}/state_<N>.sqlite`の最新N | Codex Appの状態DB（読取りのみ） |

優先順位は「環境変数 > 設定ファイル > 既定値」です。設定ファイルの場所だけを変える場合は`CODEX_TITLE_CONFIG_PATH`を使えます。再インストールとアンインストールでは既存の設定ファイルを削除・上書きしません。

JSONの整数設定は正の安全整数、環境変数の整数設定は正の10進安全整数だけを受け入れます。未知のキー、不正なJSON、空の`statePath`/`appStatePath`は設定エラーになります。

## 注意点

- **反映は1ターン遅れ**: タイトルが変わるのは、更新回の次にユーザーがメッセージを送った回答時です。メッセージを送らない限り反映されません。
- **手動リネームを保護**: 一度自動設定したタイトルをUIで変更すると、次の更新周期で差分を検出して、そのタスクの自動更新を停止します。
- **初回だけは判別不能**: 自動設定履歴がまだない初回更新では、Codexが付けた初期タイトルと手動タイトルを区別できません。最初の自動更新後から手動変更を保護します。
- **リネーム直後の手動変更は誤認しうる**: 注入したターン中〜次のHook実行までの間に手動リネームすると、その手動タイトルを自動タイトルとして採用してしまいます（以降の周期で上書きされます）。窓は狭く、通常の手動リネームは正しく検出されます。
- **アプリDB依存**: 現在タイトルの確認はCodex Appの内部DB`state_<N>.sqlite`（`threads`テーブル）に依存します。アプリ更新でスキーマが変わって読めなくなった場合、titlizeは安全側に倒して何もしません（`app_db_read_failed`をstderrに出力）。
- **会話コンテキストに指示が残る**: rename指示は`developer`メッセージとして会話履歴に永続化されます（既定で3ターンに1回）。吹き出しには表示されませんが無痕跡ではなく、thinking（推論要約）にタイトル更新への言及が出ることがあります。
- **Codex App専用**: `codex_app__set_thread_title`はCodex App（Desktop / VS Code連携）の内蔵ツールです。動作確認はCodex Desktop 0.146系。ターミナル単体の`codex`にはこのツールが無い可能性があり、その場合タイトルは更新されません。
- **モデル依存**: モデルが注入指示を無視した場合、その周期の更新はスキップされ、次の周期で再試行します。
- 旧バージョンでpendingが残ったセッションは、開いてメッセージを送ると1回だけリネームされます（回復動作）。

## 開発

```bash
bun test
bun run typecheck
bun run build   # dist/titlize を生成
```

Hook入出力の単体確認:

```bash
state_dir="$(mktemp -d)"
sqlite3 "$state_dir/state_5.sqlite" "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL); INSERT INTO threads VALUES ('s', '初期タイトル');"
printf '%s\n' '{"hook_event_name":"Stop","session_id":"s","turn_id":"t","transcript_path":null,"stop_hook_active":false}' \
  | CODEX_TITLE_EVERY=1 CODEX_TITLE_STATE_PATH="$state_dir/state.sqlite3" CODEX_TITLE_APP_STATE_PATH="$state_dir/state_5.sqlite" bun src/cli.ts hook   # => {}
printf '%s\n' '{"hook_event_name":"UserPromptSubmit","session_id":"s","turn_id":"t2","prompt":"next"}' \
  | CODEX_TITLE_EVERY=1 CODEX_TITLE_STATE_PATH="$state_dir/state.sqlite3" CODEX_TITLE_APP_STATE_PATH="$state_dir/state_5.sqlite" bun src/cli.ts hook   # => hookSpecificOutput入りJSON
```

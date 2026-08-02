# titlize

Codex Appのタスク名を、一定ターンごとに自動更新するユーザー共通Hookです。

タイトルの保存にはCodex App内蔵の`codex_app__set_thread_title`を使います。共有Server、常駐デーモン、LaunchAgent、タイトル生成用の別タスク、追加のモデル呼び出しは使いません。

## 動作

```text
Stop Hook            : session_idごとに回数を記録し、更新回ならpending_update = 1を保存（表示なし）
UserPromptSubmit Hook: 次のユーザーメッセージ時、pendingがあればadditionalContextでrename指示を注入
モデル               : 通常回答の処理中にcodex_app__set_thread_titleを1回呼ぶ → サイドバーへ即反映
```

既定では3回目の新しい`Stop`ごとに更新を予約します。同じ`turn_id`の再送と、`stop_hook_active: true`の継続側`Stop`は数えません。注入できなかったpendingは以降のメッセージで再試行します。

## セットアップ

Bun 1.3系が必要です。

```bash
bun install
bun run install:user
```

`${TITLIZE_INSTALL_DIR:-~/.local/bin}/titlize`と`${CODEX_HOME:-~/.codex}/hooks.json`を更新します。既存の他のHookは保持し、titlizeの`Stop`と`UserPromptSubmit`だけを追加・更新します。

インストール後、Codexの`/hooks`でtitlizeのHook（2件）を信頼してください。信頼されていないHookは実行されません。

アンインストールは`bun run uninstall:user`です（他のHookは残します）。

## 設定

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `CODEX_TITLE_EVERY` | `3` | 何回目の通常`Stop`で更新を予約するか |
| `CODEX_TITLE_MAX_CHARS` | `40` | タイトルの最大文字数 |
| `CODEX_TITLE_STATE_PATH` | `${CODEX_HOME:-~/.codex}/codex-title/state.sqlite3` | SQLite状態ファイル |

整数設定は正の10進安全整数だけを受け入れます。

## 注意点

- **反映は1ターン遅れ**: タイトルが変わるのは、更新回の次にユーザーがメッセージを送った回答時です。メッセージを送らない限り反映されません。
- **会話コンテキストに指示が残る**: rename指示は`developer`メッセージとして会話履歴に永続化されます（約200文字、既定で3ターンに1回）。吹き出しには表示されませんが無痕跡ではなく、thinking（推論要約）にタイトル更新への言及が出ることがあります。
- **Codex App専用**: `codex_app__set_thread_title`はCodex App（Desktop / VS Code連携）の内蔵ツールです。動作確認はCodex Desktop 0.146系。ターミナル単体の`codex`にはこのツールが無い可能性があり、その場合タイトルは更新されません。
- **手動リネームを保護しない**: 手動で付けたタイトルも次の更新周期で上書きされます（旧方式にあった手動変更検出は廃止）。
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
printf '%s\n' '{"hook_event_name":"Stop","session_id":"s","turn_id":"t","transcript_path":null,"stop_hook_active":false}' \
  | CODEX_TITLE_EVERY=1 CODEX_TITLE_STATE_PATH="$state_dir/state.sqlite3" bun src/cli.ts hook   # => {}
printf '%s\n' '{"hook_event_name":"UserPromptSubmit","session_id":"s","prompt":"next"}' \
  | CODEX_TITLE_EVERY=1 CODEX_TITLE_STATE_PATH="$state_dir/state.sqlite3" bun src/cli.ts hook   # => hookSpecificOutput入りJSON
```

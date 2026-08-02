# titlize

Codex Appのタスク名を、一定ターンごとに自動更新するユーザー共通Hookです。

タイトルの保存には、Codex App内蔵の`codex_app__set_thread_title`を使います。titlize自身はApp Serverへ接続せず、共有Server、常駐デーモン、LaunchAgent、タイトル生成用の別タスク、追加のモデル呼び出しも起動しません。

## 動作

```text
通常のCodex応答が終了
  → Stop Hookでsession_idごとの回数を記録（出力は常に {}）
  → 更新回なら pending_update = 1 を保存
次のユーザーメッセージ送信時
  → UserPromptSubmit Hookがpendingを検出
  → hookSpecificOutput.additionalContext でrename指示をモデルへ注入
  → モデルが通常回答の処理中にcodex_app__set_thread_titleを1回呼ぶ
  → タイトルが再起動なしでサイドバーへ反映される
```

既定では3回目の新しい`Stop`ごとに更新を予約します。同じ`turn_id`の再送と、`stop_hook_active: true`の継続側`Stop`は数えません。

`Stop`側は何も表示せず、モデルの継続も要求しません。rename指示は次のユーザーメッセージの回答ターンへ`additionalContext`として裏で注入されるため、追加の吹き出しや追加のモデル呼び出しは発生しません。そのぶんタイトル反映は、更新回の次にユーザーがメッセージを送った回答時になります。注入指示にはタイトル変更へ言及しないよう含めていますが、ツール実行表示の見え方はCodex App側のUIに依存します。

## セットアップ

Bun 1.3系が必要です。

```bash
bun install
bun test
bun run typecheck
bun run install:user
```

`install:user`はBunランタイム込みの単体CLIをビルドし、次へインストールします。

```text
${TITLIZE_INSTALL_DIR:-~/.local/bin}/titlize
${CODEX_HOME:-~/.codex}/hooks.json
```

既存のユーザーHookは保持し、titlizeの`Stop`と`UserPromptSubmit` Hookだけを追加または更新します。Hook定義を追加・変更した場合は、CodexのHook画面で`titlize: タスク名を更新しています`（2件）を確認して信頼してください。信頼されていないHookは実行されません。

アンインストールは次のとおりです。既存の他のHookは削除しません。

```bash
bun run uninstall:user
```

## CLI

実行コマンドはHook用だけです。

```bash
titlize hook
```

旧`titlize update --force`は廃止しました。App Serverへ直接書く旧経路を再び使わないため、引数エラーで終了します。

## 設定

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `CODEX_TITLE_EVERY` | `3` | セッションごとに何回目の通常`Stop`で更新を予約するか |
| `CODEX_TITLE_MAX_CHARS` | `40` | 注入指示に含めるタイトル最大文字数 |
| `CODEX_TITLE_STATE_PATH` | `${CODEX_HOME:-~/.codex}/codex-title/state.sqlite3` | SQLite状態ファイル |

整数設定は正の10進安全整数だけを受け入れます。

## 状態と再試行

`session_id`ごとに状態を分離し、`(session_id, turn_id)`を処理済みテーブルへ保存します。更新条件は次のとおりです。

```text
stop_count % CODEX_TITLE_EVERY == 0
または
pending_update == true
```

更新回の`Stop`で`pending_update = 1`を保存し、次の`UserPromptSubmit`でrename指示を注入できた時点で`pending_update = 0`へ戻します。注入の記録に失敗した場合は注入せずpendingを残し、以降のユーザーメッセージで再試行します。

既存DBとの互換性のため旧タイトル管理列も保持していますが、新しい自動更新経路はApp Serverのタイトル読取り・書込みには使いません。

## テストと確認

```bash
bun test
bun run typecheck
bun run build
```

Hook出力だけを一時DBで確認できます。

```bash
state_dir="$(mktemp -d)"
printf '%s\n' '{"hook_event_name":"Stop","session_id":"test-session","turn_id":"test-turn","transcript_path":null,"stop_hook_active":false}' \
  | CODEX_TITLE_EVERY=1 CODEX_TITLE_STATE_PATH="$state_dir/state.sqlite3" bun src/cli.ts hook
printf '%s\n' '{"hook_event_name":"UserPromptSubmit","session_id":"test-session","prompt":"next"}' \
  | CODEX_TITLE_EVERY=1 CODEX_TITLE_STATE_PATH="$state_dir/state.sqlite3" bun src/cli.ts hook
```

1回目の`Stop`出力は`{}`のまま、2回目の`UserPromptSubmit`出力に`hookSpecificOutput`と`codex_app__set_thread_title`が含まれれば、注入の生成は成功です。

実Appでは、新しいタスクで3回やり取りして4回目のメッセージを送り、その回答の処理中にサイドバーのタイトルが再起動なしで変わることと、余計な吹き出しが出ないことを確認します。共有Serverが存在しない確認は次です。

```bash
lsof -n -P -U | grep app-server-control.sock
```

何も出なければ共有Serverは動いていません。

# eMudhra中間CA漏えいへの対応状況

確認日: 2026-10-21（JST）

**状態: Bun修正版の正式リリース待ち。対策未完了。**

## 確認した根拠

- [インシデント案内](https://emudhra.we-have-a-problem.com/)では、Bunの修正版は引き続き`pending`。
- [Bun PR #46159](https://github.com/oven-sh/bun/pull/46159)は2026-10-20にマージ済み。マージコミットは`ea6a2c7b7c98862627760d429aa2d92221e88b0c`。
- [最新の安定版Bun 1.4.3](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.3)は2026-10-10公開、コミットは`c6da4a4d3010e5553438c60f6bd76d981976867c`。[修正コミットとの比較](https://github.com/oven-sh/bun/compare/ea6a2c7b7c98862627760d429aa2d92221e88b0c...bun-v1.4.3)でもリリース側が125コミット前で、修正を含まない。

`latest`への更新だけで対策済みとは扱わない。修正コミットの収録と、実際のTLS接続拒否を両方確認する。修正PRのマージや同梱CA一覧の確認だけでは、OSのCAや追加CAを使う経路まで検証できない。

## このリポジトリへの影響と今回の準備

- `package.json`の`packageManager`は`bun@1.3.12`。修正収録版を確認できないため、この値は据え置く。
- CIのTypecheck / Test / Buildは、`oven-sh/setup-bun`の`bun-version-file: package.json`で同じ固定値を参照する。正式な修正版が判明した際に、3ジョブの更新漏れを防ぐ。
- `src/`に外部HTTPS通信は見つからなかった。タイトル確認・状態管理はローカルSQLite、タイトル変更の指示先はCodex App。依存取得を行うBunと、`bun build --compile`でCLIに同梱されるBunランタイムは対応対象。
- `bun.lock`は開発用依存の解決結果で、Bun本体のCAを更新しない。今回は依存関係を変えないため保持する。Dockerfile、コンテナのdigest、リリース・デプロイ用ワークフローは存在しない。
- OSのCA更新も必要に応じて行うが、それだけでBunの組込CAやインストール済みCLIが更新されたとは扱わない。証明書検証を無効化する回避策は使わない。

## 今回の検証結果

macOS / arm64で確認。現行固定版は公式の`bun-darwin-aarch64.zip`を取得し、SHA-256がGitHub公式配布物の`6c4bb87dd013ed1a8d6a16e357a3d094959fd5530b4d7061f7f3680c3c7cea1c`と一致した。Bun 1.3.12のrevisionは`700fc117a2fd01ac0201deaa6fa69c5557acb04f`。

| 検証 | 結果 |
| --- | --- |
| Bun 1.3.12: `bun install --frozen-lockfile` | 成功。`package.json`と`bun.lock`に差分なし |
| Bun 1.3.12: `bun test` | 100 pass / 0 fail |
| Bun 1.3.12: `bun run typecheck` | 成功 |
| Bun 1.3.12: `bun run build` | 成功（検証用。対策済みバイナリではない） |
| 生成CLIのHook確認 | 一時SQLite・設定パスでStop、UserPromptSubmit、タイトル変更の採用を確認 |
| 生成CLIの署名確認 | `codesign --verify --strict`成功 |
| Bun 1.3.12: TLS検証 | 検証ホスト12件すべてHTTP 200、正常系`https://bun.com/`もHTTP 200 |
| Bun 1.4.3: TLS検証 | 検証ホスト12件すべてHTTP 200、正常系もHTTP 200 |
| Bun 1.3.12でcompileしたTLS検証プログラム | 検証ホスト12件すべてHTTP 200、正常系もHTTP 200 |

TLS検証は、一時的な最小プログラムからBunの既定`fetch`でGETし、リダイレクトは追わず10秒で打ち切った。検証対象は案内サイトのDV / OV / EV × G3B / G3C × 直接署名 / AAAクロス署名の12ホスト。追加CAの環境変数（`SSL_CERT_FILE`、`SSL_CERT_DIR`、`NODE_EXTRA_CA_CERTS`）は未設定で、証明書検証を無効化していない。組込CA一覧にはPR #46159の除外対象4ルートが残っていた。

これは今回のmacOS環境で**未対策であることを確認した基準結果**で、他のOSの検証結果を示すものではない。ビルドしたCLIとTLS検証用実行形式は再配布・インストールしていない。

## 正式な修正版公開後に残る作業

1. 案内サイトと[Bun公式リリース](https://github.com/oven-sh/bun/releases)を再確認し、正式版のリリースノートとコミットの両方から修正収録を確認する。上記PR以降の追加修正やクロス署名経路の対応も確認し、タグ・コミット・根拠URLを記録する。
2. `package.json`の`packageManager`を確認済みの正確なバージョンに更新する。CIはこの値を参照する。開発環境も同じバージョンに揃え、`bun --version`と`bun --revision`を記録する。
3. 実行対象OSのCAストアも確認した上で、そのBunで案内サイトにある12個の検証ホスト（直接署名・AAAクロス署名の両方）への接続が証明書の信頼エラーで拒否されることを確認する。タイムアウト、DNS失敗、HTTPエラー、証明書の期限切れだけでは対策成功と判定しない。通常のHTTPS接続が成功することも確認する。
4. 次の既存チェックを実行する。`--frozen-lockfile`が通れば、ランタイム更新のみのためにlockfileを作り直す必要はない。依存も変更する場合だけ、その変更に対応したlockfileを更新する。

   ```bash
   bun install --frozen-lockfile
   bun test
   bun run typecheck
   bun run build
   ```

5. 同じ修正版Bunを使ってTLS検証用の最小プログラムも`bun build --compile`し、手順3の正常接続・拒否接続を再確認する。CLIのビルド元Bun、生成物のSHA-256、実行OSを記録し、`dist/titlize`のHook入出力とmacOSの署名検証も行う。既存の実行形式にはBunランタイムが埋め込まれているので、ホストのBun更新だけでは置き換わらない。
6. 検証済みのCLIを利用者ごとに再インストール・再配布する。`bun run install:user`はCLIの再ビルドと配置を行う。既存の設定と他のHookが保持されることを確認する。公開・配布資産や本番環境への反映は別の承認済み作業として実施する。

今回の作業では、利用者の`~/.local/bin/titlize`や`~/.codex/hooks.json`の変更、マージ、リリース公開、既存リリース資産の置換、本番デプロイは行わない。

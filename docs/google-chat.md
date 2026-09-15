# Google Chat の接続と運用

Google Chat の1アカウント、1スペースを、指定した1つの Slack チャンネルへ接続する機能です。
既定では無効で、既存の Chatwork 経路と別のテーブルに取得結果と返信状態を保存します。
この手順は、接続を設定し、停止原因を確認して復旧する運用担当者向けです。

## ユーザー OAuth の準備

接続する利用者の Google アカウントで OAuth を認可し、対象スペースの読み取り権限を確認します。
Google Cloud の対象プロジェクトで Google Chat API を有効にし、Google Auth Platform の「クライアント」から「デスクトップ アプリ」の OAuth クライアントを作成します。
ダウンロードした JSON はリポジトリ外へ保存し、ファイルの読取権限を所有者だけにしてください。
同意画面のアプリ名はプロジェクトのブランド設定に従います。
外部ユーザー向けアプリの公開状態、テストユーザー、組織の OAuth アプリ制限は、[Google のユーザー認証手順](https://developers.google.com/workspace/chat/authenticate-authorize-chat-user)に従って設定します。

利用者を自組織に限定する場合は、OAuth の対象を「内部」に設定します。
「外部」かつ「テスト」の公開状態では、Chat スコープを含む refresh token は7日で失効するため、継続利用には公開設定の見直しか再認証が必要です。[Google の失効条件](https://developers.google.com/identity/protocols/oauth2#expiration)を確認してください。

既存の ADC（ローカル開発用の認証情報）を上書きしないよう、専用の設定ディレクトリを使います。
以下は macOS / Linux の例です。`client.json` を配置してから、利用するアカウントで同意画面を完了してください。
`--client-id-file` と `--scopes` の詳細は [gcloud の公式リファレンス](https://docs.cloud.google.com/sdk/gcloud/reference/auth/application-default/login)を参照してください。

```sh
umask 077
BRIDGE_OAUTH_DIR="$HOME/.config/chatwork-slack-bridge/google-chat"
mkdir -p "$BRIDGE_OAUTH_DIR/gcloud"
chmod 700 "$BRIDGE_OAUTH_DIR" "$BRIDGE_OAUTH_DIR/gcloud"
# ダウンロードした JSON を $BRIDGE_OAUTH_DIR/client.json に配置する。
chmod 600 "$BRIDGE_OAUTH_DIR/client.json"
CLOUDSDK_CONFIG="$BRIDGE_OAUTH_DIR/gcloud" \
  gcloud auth application-default login \
  --client-id-file="$BRIDGE_OAUTH_DIR/client.json" \
  --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/chat.messages.readonly
```

取得した `$BRIDGE_OAUTH_DIR/gcloud/application_default_credentials.json` の `client_id`、`client_secret`、`refresh_token` を使います。
この JSON 全体も `GOOGLE_CHAT_CREDENTIALS` として読み込めます。認証情報をターミナルに表示する必要はありません。

検証では、本番と別の使い捨て DB、Google Chat スペース、Slack チャンネルを使います。
Slack アプリも検証用を別に作成し、Bot トークンと signing secret を検証用 bridge に設定します。
検証用アプリの Events / Interactivity URL は、検証用 bridge の到達可能な HTTPS URL に向けてください。
本番アプリの URL は切り替えません。同じアプリを使うと返信イベントは本番 bridge に届き、別 DB のスレッド対応を解決できません。
まず返信許可ユーザー一覧を空にし、検証用チャンネルで読み取りを確認してください。
検証後の本番接続は、本番 DB に最初から本番のチャンネルと開始時刻を設定して作成します。
ユーザー OAuth は参加スペースを読む権限を持つため、対象を1スペースに制限するのは bridge の設定と検証処理です。
`GOOGLE_CHAT_ACCOUNT_EMAIL` とトークンの本人確認結果が一致し、指定スペースの取得に成功することを確認してください。
組織の制限やスペース権限で拒否される場合は、有効化を止めて管理者に必要な設定を確認します。

返信も有効にする段階で、上のコマンドの `--scopes` に `https://www.googleapis.com/auth/chat.messages.create` を追加し、再度同意します。
更新した JSON を保存先へ反映し、アプリケーションを再起動します。
返信させる Slack ユーザー ID を設定して、全レプリカを再起動します。
許可ユーザー一覧の変更では、取得位置とスレッド対応を維持できます。旧設定のプロセスを残さないでください。

Cloud Run では、JSON をファイルから Secret Manager へ登録します。
作成済みシークレットの更新には `gcloud secrets versions add` を使い、実行 SA へ対象シークレットだけの `roles/secretmanager.secretAccessor` を付与してください。

```sh
gcloud secrets create '<SECRET_NAME>' --project='<PROJECT_ID>' \
  --replication-policy=automatic \
  --data-file="$BRIDGE_OAUTH_DIR/gcloud/application_default_credentials.json"
```

`GOOGLE_CHAT_CREDENTIALS_SECRET` には `<SECRET_NAME>` を設定します。
GitHub variables、ログ、Issue に JSON の内容を貼らないでください。

## 設定

既存の DB と Slack の設定に、次の値を追加します。
`GOOGLE_CHAT_ENABLED` が未設定、`false`、`0` の場合は Google Chat の設定を読み込まず、取得も返信も開始しません。
有効化は `true` または `1` で指定します。

| 変数 | 内容 |
| --- | --- |
| `GOOGLE_CHAT_ENABLED` | 有効化のスイッチ。既定は `false` |
| `GOOGLE_CHAT_ACCOUNT_EMAIL` | 接続する Google アカウントのメールアドレス。有効化時は必須 |
| `GOOGLE_CHAT_SPACE_NAME` | 対象スペースのリソース名 `spaces/<space-id>`。有効化時は必須 |
| `GOOGLE_CHAT_SPACE_DISPLAY_NAME` | Slack の転送と送信確認に表示するスペース名。有効化時は必須 |
| `GOOGLE_CHAT_SLACK_CHANNEL_ID` | 転送先 Slack チャンネルの ID。有効化時は必須 |
| `GOOGLE_CHAT_START_TIME` | 初回取得の開始時刻。タイムゾーン付き ISO 8601 形式で明示指定する。有効化時は必須 |
| `GOOGLE_CHAT_POLL_INTERVAL_MS` | 1回の取得終了から次回開始までの待ち時間。既定は `60000`、最小は `10000` ミリ秒 |
| `GOOGLE_CHAT_ALLOWED_REPLY_USER_IDS` | 返信を許可する Slack ユーザー ID をカンマ区切りで指定。空欄なら受信専用 |
| `GOOGLE_CHAT_CREDENTIALS` | ローカルの secret adapter が読む OAuth 認証情報の JSON。有効化時は必須 |
| `GOOGLE_CHAT_CREDENTIALS_SECRET` | `SECRET_BACKEND=gcp` の場合に読む Secret Manager のシークレット名。有効化時は必須 |

Cloud Run のワークフローでは、`GOOGLE_CHAT_ACCOUNT_EMAIL`、`GOOGLE_CHAT_SPACE_NAME`、`GOOGLE_CHAT_SPACE_DISPLAY_NAME`、`GOOGLE_CHAT_SLACK_CHANNEL_ID`、`GOOGLE_CHAT_ALLOWED_REPLY_USER_IDS` を GitHub repository secrets に登録します。
接続先や名前が公開 Actions ログに出ないようにするためです。スイッチ、開始時刻、取得間隔、シークレット参照名は repository variables を使います。
OAuth JSON 本体は GitHub に登録せず、Secret Manager だけに保存してください。

認証情報の JSON は次のキーを使います。
値は接続時に設定し、リポジトリ、ログ、コマンド履歴へ残さないでください。

```json
{
  "client_id": "<OAuth client ID>",
  "client_secret": "<OAuth client secret>",
  "refresh_token": "<user refresh token>"
}
```

`SECRET_BACKEND=env` では `GOOGLE_CHAT_CREDENTIALS` にこの JSON を設定します。
`SECRET_BACKEND=gcp` では JSON 全体を Secret Manager に保存し、その名前を `GOOGLE_CHAT_CREDENTIALS_SECRET` に設定します。
認証情報は起動時に読み込むため、更新後はアプリケーションを再起動してください。

Google API が表示名を返さない場合、既定では `users/<id>` を表示します。
名前を表示するには OAuth JSON の任意項目 `sender_names` に `{"users/DUMMY":"Example sender"}` のような対応表を追加します。
設定名、API の表示名、ユーザー ID の順で使用します。名前解決のための API 権限は追加しません。
名前の対応表も秘密情報と同じ保存先に置き、ログや公開 Issue に貼らないでください。

`GOOGLE_CHAT_START_TIME` より前のメッセージは取り込みません。
未来の時刻を指定した場合は、その時刻まで取得を開始しません。
再起動時も同じ開始時刻を使い、毎回「現在時刻」へ書き換えないでください。
保存済みの取得位置と設定が一致しなくなり、接続を再開できなくなります。

## 受信と返信

先に対象 Slack チャンネルへ bridge の Bot を招待します。Slack アプリの `chat:write` と、公開チャンネルでは `channels:history` / `message.channels`、非公開では `groups:history` / `message.groups` を設定します。
スコープを変更した場合はアプリを再インストールし、Events と Interactivity の URL も [Slack セットアップ手順](setup-guide/README.md)で確認してください。

Google Chat の新着本文、送信者名、元メッセージへのリンクを Slack へ転送します。
Google Chat の同じスレッドに属する続きのメッセージは、最初の転送投稿に対応する Slack スレッドへ追加します。
本文と外部の表示名は `plain_text` ブロックで、元リンクは専用のリンクブロックでの表示です。
添付ファイルの実体転送、編集と削除の同期、リアクション、履歴検索は対象外です。

返信は次の手順で行います。

1. 転送された Slack スレッドに本文を入力します。
2. 表示された Google Chat のスペース名、送信アカウント、本文を確認してください。
3. 入力した本人が「Google Chat に送信」を押すと、対応する Google Chat スレッドへ投稿します。「キャンセル」では投稿しません。

返信の作成時とボタン操作時の両方で、許可ユーザー一覧を確認します。
許可されていても、他の利用者が入力した返信の送信ボタンは操作できません。
返信は Slack のリンク表記とエンティティを平文へ戻し、確認画面と保存済み本文に反映します。
メンションはユーザー ID の文字列表現として扱い、Google 側のユーザーへ自動変換しません。
10,000文字または UTF-8 で30,000バイトを超える場合は、送信せずに Slack に分割を案内します。

## 取得位置と重複の扱い

取得位置、取得中の期間、次ページのトークンを PostgreSQL に保存します。
1回の取得は最大5ページで、残りは次回の取得対象です。
各ページのメッセージとページの進行状況を同じトランザクションで保存し、期間内の全ページが保存されてから、作成時刻順に Slack へ転送します。
転送は1回につき最大100件で、同じ取得処理内の投稿には少なくとも1秒の間隔を設けます。
Slack の429では Retry-After を DB の `lease_until` に保存し、別レプリカもその期限まで取得を開始しません。
`not_in_channel` などの確定拒否は `pending` のまま保存し、その回の転送を終了します。原因を修正すれば次回の取得で再試行します。
送信前の表示組み立てエラーは `slack_payload_invalid` を記録し、Slack には投稿しません。対象メッセージや表示設定を確認して修正してください。

次の取得では保存済みの取得位置から60秒戻して読み直しますが、明示した開始時刻より前へは戻りません。
Google のメッセージ名の一意制約で、再取得したメッセージの重複保存を防ぎます。
期限切れなどでページトークンが拒否された場合は、取得中の期間を保持したまま先頭ページから読み直します。

複数レプリカ間の取得処理には、DB の120秒の lease と所有トークンの一致確認が必要です。
Slack 投稿の直前には `sending` を確定して保存し、外部通信中は DB トランザクションを保持しません。
送信後のプロセス停止や通信切断によって結果を保存できなかった場合、別レプリカもその投稿を自動で送り直しません。

Google Chat への返信では、送信前に独自のメッセージ ID とリクエスト ID を保存します。
送信済みメッセージの名前、または保存済みの独自 ID と一致した再取得を抑止し、転送ループを防ぎます。
同じ Google アカウントが手動で書いた別のメッセージは転送対象です。

## 設定エラーの確認

起動時の `google_chat.config_load` ログには、不正な設定の変数名と検証コードだけを出します。
例として `GOOGLE_CHAT_SLACK_CHANNEL_ID` の `invalid_format` なら、チャンネル名や `#` ではなく ID を登録したか確認してください。
値や表示名の対応表のキーはログに含めません。GitHub secrets の値は再表示できないため、手元の設定を確認して再登録します。

## 停止原因の確認

本文を含まない状態確認には、次の SQL を使用できます。

```sql
SELECT id, enabled, error_code, notification_status,
       cursor, window_after, window_before, lease_until
FROM google_chat_connections;

SELECT id, thread_id, status, error_code, slack_ts
FROM google_chat_inbox
WHERE status IN ('sending', 'unknown');

SELECT id, status, error_code, slack_confirm_ts
FROM google_chat_outbox
WHERE status IN ('sending', 'unknown');
```

`auth_revoked`、`account_mismatch`、`forbidden`、`resource_mismatch` では接続を無効化し、取得と新たな返信を停止します。
停止理由を `google_chat_connections.error_code` に保存し、Slack に復旧案内を一度だけ投稿します。
通知の結果の保存先は `notification_status` です。
`sending` または `unknown` の通知は、Slack 側の投稿有無を確認するまで再送しません。
レート制限や一時的な通信エラーでは取得位置を保持し、次回の取得で再試行します。

## 認証または権限エラーからの復旧

アカウントの一致、対象スペースへのアクセス権、OAuth の認可状態を確認します。
必要に応じて再認証し、認証情報の保存先を更新してください。
古い認証情報を持つプロセスが動かないよう、全レプリカを停止してから再起動します。

設定が保存済みの接続と一致し、停止原因を解消したことを確認した後、対象接続だけを再有効化します。
次は `psql` で `connection_id` に確認済みの内部 ID を設定して実行する SQL です。

```sql
BEGIN;
UPDATE google_chat_connections
SET enabled = true,
    error_code = NULL,
    notification_status = NULL,
    lease_token = NULL,
    lease_until = NULL
WHERE id = :'connection_id'::bigint
  AND enabled = false;
COMMIT;
```

この更新では、取得位置や返信状態を変更しません。
送信結果が不明な返信は、再有効化後に「送信結果を照会」を押して確認してください。

## Slack 転送の結果が不明な場合

`google_chat_inbox` に `sending` または `unknown` が残ると、その接続の Slack 転送全体を停止します。
メッセージの取得と保存は続きますが、後続メッセージを別の親投稿として転送することはありません。

復旧時は全レプリカを停止し、実行中の投稿が終了したことを確認します。
運用担当者が対象の Slack チャンネルとスレッドを確認し、保存済みメッセージとの対応を調べてください。
投稿を確認できた場合は、同じトランザクション内で次を更新します。

- `google_chat_inbox.slack_ts` に確認した投稿の `ts` を記録し、`status='sent'`、`error_code=NULL` にする。
- 最初の親投稿であれば、対応する `google_chat_threads.slack_root_ts` にその `ts` を記録する。既存の対応がある場合は一致を確認する。
- `google_chat_delivery_attempts` に対象の `inbox_id`、`operation='slack_forward'`、`result='operator_reconciled'` を追記する。

投稿の有無を確定できなければ、`pending` に戻さず停止を維持します。
投稿されていないことを確認し、再送を判断する場合も、対象行だけを扱ってください。
一括で状態を初期化すると、すでに投稿されたメッセージを重複転送するおそれがあります。

送信確認の Slack 投稿だけが不明になった場合は、`google_chat_outbox.error_code='confirmation_delivery_unknown'` を確認します。
確認投稿が存在すれば、運用担当者がその `ts` を `slack_confirm_ts` に記録して、以後の結果表示先を復元してください。
同じ Slack 返信イベントから確認投稿を自動で作り直すことはありません。

本文に起因する確定拒否や表示エラーを修正できず、運用担当者がその投稿を転送対象から外すと判断した場合は、全レプリカを停止して対象行だけを除外します。
原文を Google Chat で確認し、必要な内容を別途扱うことを決めてから、`psql` の `inbox_id` に確認済みの内部 ID を設定してください。
`sending` や `unknown` の行はこの操作の対象外です。

```sql
BEGIN;
WITH skipped AS (
  UPDATE google_chat_inbox
  SET status = 'suppressed'
  WHERE id = :'inbox_id'::bigint
    AND status = 'pending'
    AND error_code IN ('slack_payload_invalid', 'slack_rejected')
  RETURNING id
)
INSERT INTO google_chat_delivery_attempts (inbox_id, operation, result)
SELECT id, 'slack_forward', 'operator_skipped' FROM skipped;
COMMIT;
```

## Google Chat 返信の結果が不明な場合

返信の `sending` または `unknown` は、自動で再送しません。
「送信結果を照会」（`gc_check`）では、保存済みの独自メッセージ ID を使って GET し、スレッドと本文の一致を確認できた場合だけ送信済みにします。
メッセージが見つからない場合や照合できない場合も、POST は実行しません。
この版は応答本文の完全一致も要求します。Google 側で本文表現が変わるケースは実機返信テストで未確認のため、空白・リンク・メンションを含む往復確認を有効化前に行ってください。

送信直後のクラッシュで `sending` が残った場合も同じ手順です。
認証エラーで接続が無効なら、先に認証と接続を復旧してください。
結果を確認できないまま新しい返信を入力すると、同じ本文を二度送る可能性があるため、運用担当者の確認まで保留します。

## 保存済み設定と新しい設定が一致しない場合

アカウント、スペース、Slack チャンネル、開始時刻から作った `config_identity` を保存し、実行時の設定と比較します。
認証情報はこの比較に含めないため、同じアカウントのトークン更新だけなら取得位置を維持できます。
比較対象の設定を変えると、取得と送信を再開しません。`google_chat.config_mismatch` をログに記録するため、元の設定と照合してください。

誤変更なら、保存済みの接続に対応する元の設定へ戻します。
意図した変更なら、全レプリカを停止し、DB をバックアップしてから、既存のスレッド対応と未処理の返信をどのように扱うか決めてください。
この版には接続先の移行機能がありません。
`config_identity` や `cursor` の上書き、テーブル削除による初期化を通常の復旧手順として実行しないでください。
許可ユーザー一覧と表示名の対応表は比較対象に含めません。変更後は全レプリカを再起動します。

## Cloud Run で動かす場合

取得処理はアプリケーション内のタイマーで動きます。
停止時は実行中の API 呼び出しの結果を保存し、次のページや投稿を開始しません。強制終了が外部通信に重なった場合は、結果不明時の照合が必要です。
Google Chat を有効にする場合は、最小インスタンス数を1以上にし、リクエストのない時間も CPU を割り当てる構成にしてください。
常時稼働による費用が発生するため、既存の Chatwork 用構成から変更する際に運用費を確認します。
インスタンスが停止していた時間は、次の起動後に保存済みの取得位置から読み進めます。

## テストと実機確認

Node.js 22 と pnpm を使用します。
DB 統合テストは `GOOGLE_CHAT_TEST_DATABASE_URL` を指定した場合に実行され、未指定ではスキップします。
テストは Google Chat 用テーブルのデータを削除するため、専用の使い捨て PostgreSQL データベースを指定してください。
接続文字列を安全に環境へ設定した後、次のコマンドで実行します。

```sh
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

DB テストはマイグレーションを適用し、外部 API をモックした状態で、重複、ページング、再起動、送信確認、送信結果不明時の停止を検証します。
対象スペースの実 API 読み取り確認と、Slack 受信から確認付き Google Chat 返信までの実機 E2E は別の確認です。
後者は未確認です。
検証用スペースと Slack チャンネルで確認し、取引先スペースへのテスト投稿は実施前に利用者と調整してください。

# Chatwork → Slack Bridge セットアップマニュアル

Chatwork の新着メッセージを Slack に転送する Bridge（forwarding / Issue #3）を動かすための設定手順です。
Slack アプリ・Chatwork Webhook・シークレット登録・デプロイ・動作確認までを順に説明します。

> スクリーンショットは ZenChain ワークスペースでの実際のセットアップ例です。トークン等の秘密情報・宛先ドメイン・ルーム ID は黒塗りしています。

---

## 0. 全体像

```
Chatwork (Webhook) ──▶ Bridge (/chatwork/webhook) ──▶ Slack (chat.postMessage)
                         ├─ 署名検証（Webhookトークン）
                         ├─ 重複チェック・保存（PostgreSQL）
                         └─ ルーティング（種別/紐付けで投稿先決定）
```

必要なもの:

| 区分 | 用意するもの | 用途 | 最終的な置き場所 |
|------|------|------|------|
| Slack | Bot トークン（`xoxb-…`） | Slack 投稿 | Secret Manager |
| Slack | 集約チャンネル 2 つの ID | 未紐付けルームの転送先 | GitHub 変数（非秘密） |
| Chatwork | API トークン | ルーム名・種別・メンバー取得 | Secret Manager |
| Chatwork | Webhook 署名トークン | Webhook の署名検証 | Secret Manager |

> **前提**: Bridge 本体（foundation / cloud-deploy / forwarding）はデプロイ済みで、公開 URL（例 `https://<your-domain>/chatwork/webhook`）に到達できること。デプロイ手順は [`../deploy/cloud-run.md`](../deploy/cloud-run.md) / [`../deploy/docker.md`](../deploy/docker.md) を参照。

---

## 1. Slack の設定

### 1-1. アプリを作成する

[https://api.slack.com/apps](https://api.slack.com/apps) を開き、対象ワークスペースにログインして **「Create New App」** をクリックします。

![Your Apps](images/01-your-apps.png)

**「From scratch」** を選びます。

![Create an app](images/02-create-an-app-dialog.png)

アプリ名（例: `Chatwork Slack Bridge`）を入力し、インストール先ワークスペースを選んで **「Create App」**。

![Name app & choose workspace](images/03-name-and-workspace.png)

作成すると Basic Information 画面になります。

![Basic Information](images/04-basic-information.png)

### 1-2. Bot スコープ `chat:write` を追加する

左メニュー **「OAuth & Permissions」** →「ボットトークンのスコープ」で **`chat:write`** を追加します。

![Add chat:write scope](images/05-bot-scope-chat-write.png)

### 1-3. ワークスペースにインストールしてトークンを取得する

**「Install App」**（または OAuth 画面の「Install to ＜ワークスペース＞」）→ 権限の確認画面で **「許可する」**。

![OAuth allow](images/06-oauth-allow.png)

インストール後、**Bot User OAuth Token（`xoxb-…`）** が表示されます。これが `SLACK_BOT_TOKEN` です。後で Secret Manager に登録します（**第三者に開示しない**こと）。

![Installed Bot token](images/07-installed-bot-token.png)

### 1-4. 集約チャンネルを 2 つ作成し、Bot を招待する

未紐付けルームの転送先となる集約チャンネルを 2 つ作成します（例: `chatwork-groups`＝グループ用、`chatwork-dms`＝DM 用）。Slack で **「+」→「チャンネル」** から作成します。

![Create channel](images/08-create-channel.png)

作成した各チャンネルに **Bot（Chatwork Slack Bridge）を招待**します:

1. チャンネルを開く → チャンネル名をクリック → **「インテグレーション」** タブ
2. **「アプリを追加する」** → 一覧から **Chatwork Slack Bridge** を選び **「追加」**

> `/invite @Chatwork Slack Bridge` をメッセージ欄から実行しても招待できます。

各チャンネルの **チャンネル ID（`C…`）** を控えます（チャンネル詳細の最下部「チャンネル ID」でコピー可能）。これが `SLACK_DEFAULT_GROUP_CHANNEL_ID` / `SLACK_DEFAULT_DM_CHANNEL_ID` です。

---

## 2. Chatwork の設定

### 2-1. API トークンを取得する

[API トークン画面](https://www.chatwork.com/service/packages/chatwork/subpackages/api/token.php)（設定 → サービス連携 → API → APIトークン）でトークンを取得します。これが `CHATWORK_API_TOKEN`（ルーム名・種別・メンバー取得に使用）です。

![Chatwork API token](images/12-chatwork-api-token.png)

> このトークンを持つアカウントが、**転送したいルームに参加している**必要があります（未参加ルームは取得不可）。

### 2-2. Webhook を作成する

[Webhook 画面](https://www.chatwork.com/service/packages/chatwork/subpackages/webhook/list.php) →「新規作成」で以下を設定します:

- **Webhook 名**: 任意（例 `chatwork-slack-bridge`）
- **Webhook URL**: `https://<your-domain>/chatwork/webhook`（デプロイ済み Bridge の公開 URL）
- **イベント**: **「ルームイベント」** → **「メッセージ作成」** にチェック
- **ルーム ID**: 転送したい Chatwork ルームの ID（チャットを開いたときの URL `#!rid` の後の数字）

![Chatwork webhook form](images/13-chatwork-webhook-form.png)

「作成」すると、**Webhook 設定 ID** と **署名トークン**が発行されます。この署名トークンが `CHATWORK_WEBHOOK_TOKEN`（Webhook の署名検証に使用）です。

![Chatwork webhook created](images/14-chatwork-webhook-created.png)

> **⚠ 複数ルームについて**: Chatwork の「ルームイベント」Webhook は **1 ルーム = 1 Webhook** で、**それぞれ別の署名トークン**が発行されます。現バージョンの Bridge は単一の `CHATWORK_WEBHOOK_TOKEN` で検証するため、まずは **1 ルームでの利用**を想定しています。複数ルーム対応（トークンの DB 管理）は今後のフェーズで対応予定です。

---

## 3. シークレット・設定の登録（GCP / GitHub）

Bridge は本番（`SECRET_BACKEND=gcp`）で、**秘密の実体を Secret Manager**に置き、**GitHub Actions の変数にはシークレット「名」と非秘密の設定値**を置きます（実トークンは GitHub に置かない）。

### 3-1. Secret Manager にトークンを登録する

```bash
PROJECT=<your-gcp-project>
RUNTIME_SA=<cloud-run-runtime-service-account>   # 例: cloud-run-sa@<project>.iam.gserviceaccount.com

create_secret () {  # name value
  printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic --project "$PROJECT"
  gcloud secrets add-iam-policy-binding "$1" \
    --member="serviceAccount:$RUNTIME_SA" \
    --role="roles/secretmanager.secretAccessor" --project "$PROJECT"
}

create_secret chatwork-slack-bridge-chatwork-webhook-token '<CHATWORK_WEBHOOK_TOKEN>'
create_secret chatwork-slack-bridge-chatwork-api-token     '<CHATWORK_API_TOKEN>'
create_secret chatwork-slack-bridge-slack-bot-token        '<SLACK_BOT_TOKEN>'
```

### 3-2. GitHub repository variables を登録する

デプロイワークフロー（`.github/workflows/deploy-cloud-run.yml`）は `vars.*` を参照します。3 つのトークンは **Secret Manager のシークレット名**、2 つのチャンネル ID は **値そのもの**を入れます。

```bash
REPO=<owner>/<repo>
gh variable set CHATWORK_WEBHOOK_TOKEN_SECRET --repo "$REPO" --body "chatwork-slack-bridge-chatwork-webhook-token"
gh variable set CHATWORK_API_TOKEN_SECRET     --repo "$REPO" --body "chatwork-slack-bridge-chatwork-api-token"
gh variable set SLACK_BOT_TOKEN_SECRET        --repo "$REPO" --body "chatwork-slack-bridge-slack-bot-token"
gh variable set SLACK_DEFAULT_GROUP_CHANNEL_ID --repo "$REPO" --body "<group channel id>"   # 例: C0XXXXXXX
gh variable set SLACK_DEFAULT_DM_CHANNEL_ID     --repo "$REPO" --body "<dm channel id>"      # 例: C0YYYYYYY
```

> ローカル（`SECRET_BACKEND=env`）で動かす場合は、これらを `.env` に直接設定します（`.env.example` 参照）。`.env` はコミットしないこと。

---

## 4. デプロイと動作確認

### 4-1. デプロイ

`main` への push（または既定のデプロイ手順）でデプロイします。デプロイ時にマイグレーション（`chatwork_rooms` / `chatwork_messages`）が適用されます。

### 4-2. ヘルスチェック

```bash
curl -i https://<your-domain>/health        # → 200 {"status":"ok","db":"ok"}
```

### 4-3. 署名検証の確認（任意）

署名なし／不正署名のリクエストは拒否されます（公開エンドポイントは署名で認可）。

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<your-domain>/chatwork/webhook \
  -H "Content-Type: application/json" -d '{"test":true}'   # → 401
```

### 4-4. 転送テスト

Webhook を設定した Chatwork ルームに**テストメッセージを 1 通投稿**します。
未紐付けのグループルームなら、`SLACK_DEFAULT_GROUP_CHANNEL_ID` のチャンネル（例 `#chatwork-groups`）に転送されれば成功です。

---

## 5. 転送ルーティングの仕組み

| 条件 | DB 保存 | Slack 投稿先 |
|------|:------:|------------|
| `room_type = my`（マイチャット） | ✕ | ✕（転送しない） |
| `enabled = false`（無効化） | ○ | ✕（保存のみ） |
| 紐付け済み（`slack_channel_id` あり） | ○ | その専用チャンネル |
| 未紐付け ＋ `room_type = group` | ○ | `SLACK_DEFAULT_GROUP_CHANNEL_ID` |
| 未紐付け ＋ `room_type = direct` | ○ | `SLACK_DEFAULT_DM_CHANNEL_ID` |

- 初見ルームは `enabled = true` / 専用チャンネル未設定で自動登録され、種別集約チャンネルへ流れます。
- 後から `chatwork_rooms.slack_channel_id` を設定すると専用チャンネルへ切り替わります。
- 不要なルームは `enabled = false` で保存のみ（Slack 投稿を停止）にできます。

---

## 6. 既知の制限・今後の改善

- **送信者表示**: 現状は送信者が account_id（数字）で表示されます。表示名解決は [#17](https://github.com/anyoneanderson/chatwork-slack-bridge/issues/17) で対応予定。
- **絵文字・添付・装飾**: Chatwork 独自のメッセージ記法（`(emoticon)` / `[info]` / `[download]` 等）の整形は [#17](https://github.com/anyoneanderson/chatwork-slack-bridge/issues/17)、添付ファイルの Slack 再アップロードは [#18](https://github.com/anyoneanderson/chatwork-slack-bridge/issues/18) で対応予定。
- **複数ルーム**: 上記のとおり Chatwork はルームごとに別トークンのため、マルチルーム（トークンの DB 管理）と管理 CLI を今後のフェーズで予定。
- **Slack → Chatwork 返信**: [#4 slack-reply](https://github.com/anyoneanderson/chatwork-slack-bridge/issues/4) で対応予定。

---

## 設定値リファレンス

| キー | 種別 | 説明 |
|------|------|------|
| `CHATWORK_WEBHOOK_TOKEN` | secret | Webhook 署名検証用トークン |
| `CHATWORK_API_TOKEN` | secret | Chatwork API（ルーム/メンバー取得）用トークン |
| `SLACK_BOT_TOKEN` | secret | Slack 投稿用 Bot トークン（`chat:write`） |
| `SLACK_DEFAULT_GROUP_CHANNEL_ID` | config | グループ種別の集約チャンネル ID |
| `SLACK_DEFAULT_DM_CHANNEL_ID` | config | DM 種別の集約チャンネル ID |

gcp バックエンドでは、上記 secret は GitHub 変数 `*_SECRET`（Secret Manager のシークレット名）経由で実行時に取得されます。

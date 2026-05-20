# Chatwork Slack Bridge システム概要

## 目的

Chatwork を日常的に開かずに、クライアントとのやり取りを Slack に集約する。

まずは Chatwork の新着メッセージを Slack に転送し、Slack 上で内容確認・返信案作成・送信確認を行える状態を目指す。将来的には Claude / ChatGPT / MCP から履歴検索、要約、未返信チェック、返信案作成を行えるようにする。

## 基本方針

- Chatwork は入出力先として扱い、普段の操作面は Slack に寄せる。
- Chatwork からの受信は Webhook を使う。
- Chatwork への送信は Chatwork API を使う。
- Slack からの送信は即時投稿ではなく、送信確認を挟む。
- 受信した Chatwork メッセージは自前DBに保存し、後続の検索・要約・重複防止に使う。
- AI は最初から自動送信させず、下書き・要約・未返信検出に使う。
- OSSとして配布しやすいよう、特定クラウド専用ではなく Docker + PostgreSQL で動く構成を基本にする。
- Cloud Run、Neon、Cloud Tasks は推奨デプロイ例またはアダプタとして扱う。

## 全体構成

```text
Chatwork Webhook
  -> Bridge API: Hono app
  -> PostgreSQL
  -> Slack API
  -> Slack channel / thread

Slack action / slash command / thread reply
  -> Bridge API: Hono app
  -> PostgreSQL
  -> Chatwork API
  -> Chatwork room

Claude / ChatGPT / MCP
  -> Bridge API or DB-backed search API
  -> message history / reply drafts / unread checks
```

## 推奨インフラ

OSS本体は以下で動く構成にする。

- Docker
- Node.js
- PostgreSQL
- Slack App
- Chatwork Webhook
- Chatwork API Token

推奨デプロイ例。

- Cloud Run
- Neon PostgreSQL
- Secret Manager
- Cloud Logging

運用が増えてきたら追加するもの。

- Cloud Tasks
  - Slack 投稿や Chatwork 送信のリトライ
  - レート制限対策
  - 遅延実行
- Pub/Sub
  - Webhook受信と後続処理の分離
  - 非同期イベント処理
- Error Reporting / Monitoring
  - 失敗検知
  - Slack通知
- Queue adapter
  - MVP は DB-backed queue でもよい
  - Google Cloud 運用では Cloud Tasks adapter を使う
- Secret adapter
  - ローカル/Docker は `.env`
  - Google Cloud 運用では Secret Manager

## 主要ユースケース

### 1. Chatwork 新着メッセージを Slack に転送

1. Chatwork Webhook が Bridge API に送信される。
2. Bridge API が Webhook 署名を検証する。
3. `room_id`、`message_id`、送信者、本文、送信時刻を PostgreSQL に保存する。
4. Slack の専用チャンネルに投稿する。
5. Slack の `channel_id`、`ts`、`thread_ts` を PostgreSQL に保存する。

Slack 表示例。

```text
[Chatwork] 株式会社Example / 案件A
田中さん:
明日のMTGですが、15時に変更可能でしょうか？

Actions: [返信案を作る] [Chatworkで開く] [対応済みにする]
```

### 2. Slack から Chatwork に返信

安全性を優先し、最初は確認ボタン方式にする。

1. Slack スレッドに返信文を書く。
2. Bot が「Chatworkへ送信しますか？」を表示する。
3. ユーザーが送信ボタンを押す。
4. Bridge API が対象の `room_id` を PostgreSQL から引く。
5. Chatwork API でメッセージを投稿する。
6. Slack スレッドに送信結果を記録する。

送信確認例。

```text
Chatworkへ送信しますか？

送信先: 株式会社Example / 案件A
本文:
明日15時で問題ありません。よろしくお願いいたします。

Actions: [送信する] [キャンセル]
```

### 3. AI に返信案を作らせる

1. Slack の「返信案を作る」ボタンを押す。
2. Bridge API が対象スレッドの前後文脈を取得する。
3. Claude / ChatGPT に返信案を生成させる。
4. Slack スレッドに下書きとして投稿する。
5. 人間が確認・編集して送信する。

### 4. 未返信チェック

毎朝または任意タイミングで、PostgreSQL 上の履歴から未対応候補を抽出する。

判定材料。

- 最新メッセージが相手発信
- Slack 側で `対応済み` が押されていない
- 一定時間以上返信がない
- メンションや疑問文を含む

通知先。

- Slack DM
- Slack 専用チャンネル
- Claude / ChatGPT / Codex の定期チェック

## PostgreSQL データモデル案

### `chatwork_rooms`

```sql
create table chatwork_rooms (
  id bigint generated always as identity primary key,
  chatwork_room_id text not null unique,
  room_name text not null,
  slack_channel_id text not null,
  enabled boolean not null default true,
  default_reply_mode text not null default 'confirm',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### `chatwork_messages`

```sql
create table chatwork_messages (
  id bigint generated always as identity primary key,
  chatwork_room_id text not null references chatwork_rooms(chatwork_room_id),
  chatwork_message_id text not null,
  chatwork_account_id text,
  sender_name text,
  body text not null,
  sent_at timestamptz not null,
  slack_channel_id text,
  slack_ts text,
  slack_thread_ts text,
  status text not null default 'open',
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chatwork_room_id, chatwork_message_id)
);

create index chatwork_messages_room_sent_at_idx
  on chatwork_messages (chatwork_room_id, sent_at desc);

create index chatwork_messages_status_idx
  on chatwork_messages (status);
```

### `outbound_messages`

```sql
create table outbound_messages (
  id bigint generated always as identity primary key,
  chatwork_room_id text not null references chatwork_rooms(chatwork_room_id),
  source text not null default 'slack',
  slack_channel_id text not null,
  slack_user_id text not null,
  slack_thread_ts text,
  body text not null,
  status text not null default 'pending',
  chatwork_message_id text,
  error_message text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index outbound_messages_room_created_at_idx
  on outbound_messages (chatwork_room_id, created_at desc);

create index outbound_messages_status_idx
  on outbound_messages (status);
```

### `delivery_attempts`

```sql
create table delivery_attempts (
  id bigint generated always as identity primary key,
  outbound_message_id bigint references outbound_messages(id),
  target text not null,
  status text not null,
  attempt_count integer not null default 1,
  error_message text,
  created_at timestamptz not null default now()
);

create index delivery_attempts_outbound_message_id_idx
  on delivery_attempts (outbound_message_id);
```

> スキーマ方針（`docs/coding-rules.md` の「データベース（PostgreSQL / Drizzle）」参照）:
> - 主キーは `bigint generated always as identity`（`serial`/`bigserial` は使わない）。
> - FK カラムには明示的に index を張る（PostgreSQL は自動で張らないため。上記 `delivery_attempts.outbound_message_id` が例）。`ai_drafts` / `message_embeddings` の FK にも同様の index を追加する。
> - `status` 等の可変ビジネス値は `text` のままとし、`CHECK` 制約または lookup テーブルで値を制限する。

### `ai_drafts`

```sql
create table ai_drafts (
  id bigint generated always as identity primary key,
  chatwork_room_id text not null references chatwork_rooms(chatwork_room_id),
  source_message_id bigint references chatwork_messages(id),
  slack_channel_id text,
  slack_thread_ts text,
  prompt text,
  draft_body text not null,
  model text,
  created_by_slack_user_id text,
  created_at timestamptz not null default now()
);
```

## HTTP エンドポイント案

### `POST /chatwork/webhook`

Chatwork Webhook を受ける。

主な処理。

- 署名検証
- イベント種別確認
- 重複チェック
- PostgreSQL 保存
- Slack 投稿

### `POST /slack/events`

Slack Events API を受ける。

主な処理。

- Slack 署名検証
- URL verification 対応
- スレッド返信検出
- 送信確認メッセージ作成

### `POST /slack/interactions`

Slack のボタン操作やモーダル送信を受ける。

主な処理。

- 送信確認
- 返信案生成
- 対応済みマーク
- キャンセル処理

### `POST /internal/send-chatwork-message`

Chatwork へ送信する内部API。

Cloud Tasks などの外部キューを使う場合は、このエンドポイントをタスク実行先にする。

## アダプタ境界

OSSとして育てるため、外部サービス依存は薄いアダプタに閉じ込める。

```text
src/
  adapters/
    chatwork/
    slack/
    queue/
    secrets/
    ai/
  app/
    routes/
    services/
  db/
    schema.ts
    migrations/
```

初期実装で用意するアダプタ。

- `chatwork`: Chatwork API / Webhook payload / 署名検証
- `slack`: Slack Web API / request署名検証 / interactive components
- `queue`: DB-backed queue
- `secrets`: environment variables

Google Cloud向けに追加するアダプタ。

- `queue`: Cloud Tasks
- `secrets`: Secret Manager

将来候補。

- `ai`: OpenAI / Claude
- `search`: pgvector / 外部ベクトルDB
- `source`: Teams / LINE WORKS / Discord

## Slack App に必要な機能

- Bot token
- Signing secret
- Incoming message posting
- Interactive components
- Slash commands
- Event subscriptions

想定コマンド。

```text
/cw send
/cw draft
/cw open
/cw done
/cw pending
```

最初から全部作らず、MVP ではボタン操作中心でよい。

## セキュリティ

必須。

- Chatwork Webhook 署名検証
- Slack request 署名検証
- Chatwork API token は secret adapter 経由で扱う
- Slack bot token は secret adapter 経由で扱う
- PostgreSQL 接続文字列は secret adapter 経由で扱う
- 公開エンドポイントは必要最小限にする
- PostgreSQL には必要なメッセージだけ保存
- ログにAPIトークンや全文メッセージを不用意に出さない

推奨。

- 送信操作は Slack user allowlist で制限
- 送信前確認を必須化
- 送信履歴を保存
- 失敗時は Slack に通知
- ルームごとに有効/無効を切り替え可能にする

## Chatwork 側の注意点

- API token を持つアカウントが対象ルームに参加している必要がある。
- 投稿権限がないルームには送信できない。
- API レート制限を考慮する。
- 過去ログ取得は万能ではないため、受信後は自前DBに保存する。
- 無料プランでもAPI利用は可能とされているが、組織設定によって管理者承認が必要な場合がある。

## Slack 側の注意点

- スレッド返信をすべて自動送信すると誤爆しやすい。
- 最初は確認ボタン方式にする。
- Slack のメッセージ編集と Chatwork 側の編集を同期するかは後回しでよい。
- Slack 側のリアクションや対応済みボタンでステータス管理できると便利。

## MCP / AI 連携の位置付け

MCP はリアルタイム中継の主役ではなく、履歴検索や補助操作に使う。

向いている用途。

- 最近のやり取りを要約する
- 未返信候補を探す
- 返信案を作る
- 特定クライアントとの過去経緯を検索する
- 今日対応すべきChatworkメッセージを一覧化する

向いていない用途。

- Webhook の代替
- 常時リアルタイム監視
- 人間確認なしの自動返信

MCP 用には、Chatwork API を直接叩かせるより、PostgreSQL に保存した履歴を検索する Bridge API を用意する方が扱いやすい。

PostgreSQL に寄せるメリット。

- 未返信判定をSQLで書きやすい
- ルーム、メッセージ、Slackスレッド、送信履歴の関連を扱いやすい
- MCPやAI向けに期間・相手・状態で絞り込みやすい
- 将来的に全文検索、pgvector、分析クエリへ拡張しやすい

将来的にRAG化する場合も、まずは PostgreSQL に `message_embeddings` のようなテーブルを追加し、pgvector で近傍検索する方針にする。

```sql
create table message_embeddings (
  id bigint generated always as identity primary key,
  chatwork_message_id bigint not null references chatwork_messages(id),
  content text not null,
  embedding vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

## MVP スコープ

最初に作るもの。

1. Chatwork Webhook 受信
2. Slack 転送
3. PostgreSQL 保存
4. Slack から送信確認つき返信
5. Chatwork API 投稿
6. 送信結果を Slack スレッドに記録
7. 対応済みボタン

後回しにするもの。

- AI返信案
- MCP検索
- 過去ログ一括取り込み
- 複数Slackチャンネルへの柔軟なルーティング
- 添付ファイル同期
- Chatworkメッセージ編集/削除の同期
- Teams 連携

## 実装ステップ案

### Phase 1: OSS MVP

- Hono で `/chatwork/webhook` を作る。
- Chatwork Webhook 署名を検証する。
- PostgreSQL に保存する。
- Slack チャンネルに投稿する。
- Docker Compose でローカル起動できるようにする。

### Phase 2: Slack から返信

- Slack App に interactive components を設定する。
- Slack スレッド返信を検出する。
- 送信確認ボタンを出す。
- Chatwork API で投稿する。
- 送信成功/失敗を Slack に返す。

### Phase 3: 運用安全性

- DB-backed queue を追加する。
- リトライとレート制限対応を入れる。
- allowlist を入れる。
- エラー通知を入れる。
- 対応済み/未対応ステータスを入れる。

### Phase 4: AI/MCP

- PostgreSQL 検索APIを作る。
- 未返信チェックを作る。
- 返信案生成を作る。
- MCP サーバーまたは ChatGPT/Claude 連携を追加する。

### Phase 5: 推奨クラウドデプロイ

- Cloud Run 用 Dockerfile / deploy sample を用意する。
- Neon PostgreSQL の pooled connection 例を用意する。
- Cloud Tasks adapter を追加する。
- Secret Manager adapter を追加する。

## 技術スタック

採用方針。

- Runtime: Node.js
- Language: TypeScript
- HTTP framework: Hono
- DB: PostgreSQL
- ORM / query builder: Drizzle
- Validation: Zod
- Slack API: `@slack/web-api`
- Chatwork API: 薄い自前 client
- Queue: DB-backed queue
- Deploy: Docker

推奨クラウド構成。

- Deploy: Cloud Run
- Hosted PostgreSQL: Neon
- Queue: Cloud Tasks
- Secrets: Secret Manager

Hono を使う理由。

- Webhook受信とJSON API中心の小さなサービスに合う。
- NestJSほど構成が重くない。
- Cloud Run に載せやすい。
- TypeScriptでルーティングとミドルウェアを薄く書ける。

Drizzle を使う理由。

- SQLに近い形で書ける。
- PostgreSQL と相性がよい。
- Cloud Run の小さなAPIで扱いやすい。
- pgvector や生SQL寄りの検索処理を混ぜやすい。
- Prisma よりランタイムが軽く、今回の中継サーバー用途に合う。

DB接続方針。

- PostgreSQL を主DBにする。
- OSS本体は `DATABASE_URL` で任意のPostgreSQLに接続する。
- Cloud Run + Neon では pooled connection を使う。
- 接続文字列は secret adapter 経由で扱う。
- マイグレーションは Drizzle Kit で管理する。

## デプロイ方針

OSS本体は Docker で動く構成を基準にする。

理由。

- Cloud Run、Fly.io、Render、Railway、VPS などに載せやすい。
- 利用者が自分の環境に合わせてホスティング先を選べる。
- Cloud Run は Docker コンテナをそのまま動かせるため、自分用の本番運用にもつなげやすい。

推奨する公開デプロイ例。

- `docker-compose.yml`
  - ローカル開発用
  - アプリ + PostgreSQL
- `Dockerfile`
  - Cloud Run / Fly.io / Render / Railway などで共通利用
- `.github/workflows/deploy-cloud-run.yml`
  - 自分用のCloud Runデプロイ
  - OSS利用者にとっても実運用サンプルになる
- `docs/deploy/cloud-run.md`
  - Google Cloud向け手順
- `docs/deploy/docker.md`
  - Docker単体 / VPS向け手順

## CI/CD 公開方針

GitHub Actions の workflow は公開してよい。

公開してよいもの。

- Docker build 手順
- テスト実行手順
- Drizzle migration チェック
- Cloud Run deploy コマンド
- 必要な環境変数名
- 必要な GitHub Secrets 名
- Google Cloud Workload Identity Federation の利用例

公開しないもの。

- `CHATWORK_API_TOKEN`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `DATABASE_URL`
- `GCP_SERVICE_ACCOUNT_KEY`
- 実際のSlackチャンネルID
- 実際のChatworkルームID
- クライアント名や本文を含むログ・fixture

GitHub Actions では、秘密情報を workflow に直接書かず、GitHub Secrets または GitHub Environments に入れる。

想定するSecrets。

```text
CHATWORK_API_TOKEN
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
DATABASE_URL
GCP_PROJECT_ID
GCP_REGION
GCP_SERVICE_NAME
GCP_WORKLOAD_IDENTITY_PROVIDER
GCP_SERVICE_ACCOUNT
```

workflow にはSecret名だけを書く。

```yaml
on:
  push:
    branches: [main]

jobs:
  deploy:
    if: github.repository == 'owner/chatwork-slack-bridge'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}
      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy "${{ secrets.GCP_SERVICE_NAME }}" \
            --project "${{ secrets.GCP_PROJECT_ID }}" \
            --region "${{ secrets.GCP_REGION }}" \
            --source . \
            --allow-unauthenticated
```

補足。

- GCP認証はサービスアカウントJSONより Workload Identity Federation を優先する。
- 自分用の本番デプロイ workflow を公開してもよいが、production環境の値は GitHub Environments / Secrets に閉じ込める。
- OSS利用者向けには、`deploy-cloud-run.example.yml` を別途用意してもよい。
- `if: github.repository == 'owner/chatwork-slack-bridge'` を入れると、fork先で意図せず本番デプロイが走る事故を避けやすい。

## 未決定事項

- Slack での送信UI
  - スレッド返信 + 確認ボタン
  - `/cw send` コマンド
  - モーダル入力
- AIプロバイダ
  - Claude
  - ChatGPT
  - 両方

## 判断メモ

この用途では、既存OSSをそのまま使うより自前で小さく作る方が安全。

理由。

- 既存実装は片方向転送が多い。
- 古い実装が多く、Chatwork v2 / Slack interactive components / Secret Manager / Cloud Run 前提に合わない。
- 業務チャットのため、署名検証・送信確認・監査ログが必要。
- AI連携やMCP連携は自前DBを中心にした方が拡張しやすい。

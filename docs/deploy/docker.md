# Docker 単体 / VPS デプロイ手順

Chatwork Slack Bridge を Docker イメージ単体（自前 VPS など、Cloud Run を使わない環境）で動かすための手順です。

このページの運用は **`SECRET_BACKEND=env`**（`DATABASE_URL` を環境変数で直接注入）を前提とします。
Cloud Run での運用（`SECRET_BACKEND=gcp` / Secret Manager 取得）は [cloud-run.md](./cloud-run.md) を参照してください。

> 実値（接続文字列・パスワード・ホスト名・プロジェクト ID 等）はこのドキュメントに書きません。
> すべて `<...>` のプレースホルダで示します。各自の値に置き換えてください。

## 前提

- Docker がインストールされていること。
- 到達可能な PostgreSQL（自前 / マネージド / Neon など）があり、接続文字列を用意できること。
- DB のスキーマ適用（`pnpm db:migrate`）は **コンテナ外**で別途実施する運用とします（イメージは起動時に migration を行いません）。

## 1. イメージをビルドする

リポジトリルート（`Dockerfile` のある階層）で実行します。

```bash
docker build -t chatwork-slack-bridge:local .
```

- マルチステージ（builder → runner）の本番イメージです。runner は非 root（`node`）で実行され、`dist` と prod 依存のみを含みます。
- 秘密情報はイメージに焼き込まれません。すべて実行時に環境変数で注入します。

## 2. コンテナを起動する

最小構成（`SECRET_BACKEND` は既定の `env`、`DATABASE_URL` を `-e` で注入）：

```bash
docker run --rm \
  -p 8080:8080 \
  -e DATABASE_URL='postgres://<USER>:<PASSWORD>@<HOST>:5432/<DB>?sslmode=require' \
  chatwork-slack-bridge:local
```

ポートについて（重要）:

- `Dockerfile` は `EXPOSE 8080` を宣言し、runner に `ENV PORT=8080` を設定済みです。
  そのため `-e PORT` を渡さなくても **コンテナは 8080 で listen** します。上記の `-p 8080:8080` でそのまま到達できます。
- ポートを変えたい場合のみ `-e PORT=<PORT>` で上書きし、`-p` のコンテナ側ポートも合わせます
  （例: `-e PORT=3000 -p 3000:3000`）。

`SECRET_BACKEND=env` であることを明示し、ログレベル等も指定する例：

```bash
docker run --rm \
  -p 8080:8080 \
  -e NODE_ENV=production \
  -e SECRET_BACKEND=env \
  -e DATABASE_URL='postgres://<USER>:<PASSWORD>@<HOST>:5432/<DB>?sslmode=require' \
  -e DB_POOLED=false \
  -e LOG_LEVEL=info \
  -e CHATWORK_WEBHOOK_TOKEN='<CHATWORK_WEBHOOK_TOKEN>' \
  -e CHATWORK_API_TOKEN='<CHATWORK_API_TOKEN>' \
  -e SLACK_BOT_TOKEN='<SLACK_BOT_TOKEN>' \
  -e SLACK_DEFAULT_GROUP_CHANNEL_ID='<SLACK_DEFAULT_GROUP_CHANNEL_ID>' \
  -e SLACK_DEFAULT_DM_CHANNEL_ID='<SLACK_DEFAULT_DM_CHANNEL_ID>' \
  chatwork-slack-bridge:local
```

> forwarding フェーズ以降、上記 5 変数（トークン 3 + チャンネル ID 2）は `ConfigSchema` で必須のため、未指定だと起動時に `ConfigError` で停止します。最小構成例（前述）はこれらの注入を省いているため、forwarding を動かす場合は本例のように全変数を渡してください。トークンの実値はシェル履歴・ログに残さない（`--env-file` 推奨）。

> Neon の **pooled**（PgBouncer transaction mode）エンドポイントを使う場合は `DB_POOLED=true` を指定してください
> （prepared statement を無効化します）。direct エンドポイントなら `false`（既定）のままで構いません。
> SSL は接続文字列の `sslmode=require` で表現します（コード側に SSL 分岐はありません）。

## 3. 疎通確認（/health）

起動後、`/health` が `200` を返せば DB 疎通も含めて正常です。

```bash
curl -i http://localhost:8080/health
```

- `200`: 正常（DB ping 成功）。
- `503`: DB へ ping できない（接続文字列・ネットワーク・`sslmode` を確認）。

## 4. 環境変数一覧（Docker 単体 / VPS 運用）

キーは `src/config/env.ts`（`ConfigSchema`）の検証対象と一致します。秘密の実値は書かず、起動時に注入してください。

| 変数 | 必須 | 既定値 | 説明 |
|------|:----:|--------|------|
| `DATABASE_URL` | 必須 | なし | PostgreSQL 接続文字列。例: `postgres://<USER>:<PASSWORD>@<HOST>:5432/<DB>?sslmode=require`。`SECRET_BACKEND=env` のとき本変数を直接注入する |
| `CHATWORK_WEBHOOK_TOKEN` | 必須 | なし | Chatwork Webhook 署名検証用トークン（base64・秘密）。`env` 運用では実値を直接注入する |
| `CHATWORK_API_TOKEN` | 必須 | なし | Chatwork API（`GET /rooms` 等）トークン（秘密）。`env` 運用では実値を直接注入する |
| `SLACK_BOT_TOKEN` | 必須 | なし | Slack 投稿用 Bot トークン（`chat:write`・秘密）。`env` 運用では実値を直接注入する |
| `SLACK_DEFAULT_GROUP_CHANNEL_ID` | 必須 | なし | group 種別の集約フォールバック Slack チャンネル ID（非秘密の設定値） |
| `SLACK_DEFAULT_DM_CHANNEL_ID` | 必須 | なし | direct 種別の集約フォールバック Slack チャンネル ID（非秘密の設定値） |
| `SECRET_BACKEND` | 任意 | `env` | secret 取得バックエンド。Docker 単体 / VPS は **`env`**。Cloud Run は `gcp`（[cloud-run.md](./cloud-run.md)） |
| `PORT` | 任意 | `8080`（イメージ既定） / スキーマ既定 `3000` | listen ポート。イメージは `ENV PORT=8080` を設定済みなので未指定なら 8080。`-e` で上書き可 |
| `NODE_ENV` | 任意 | `production`（イメージ既定） | 実行環境（`development` / `test` / `production`）。runner で `ENV NODE_ENV=production` 済み |
| `DB_POOLED` | 任意 | `false` | Neon pooled 接続時に `true`。`true` / `false` / `1` / `0` を受け付ける |
| `LOG_LEVEL` | 任意 | `info` | pino のログレベル（`fatal` / `error` / `warn` / `info` / `debug` / `trace`） |
| `DB_HEALTH_TIMEOUT_MS` | 任意 | `2000` | `/health` の DB ping タイムアウト上限（ミリ秒） |
| `GOOGLE_CLOUD_PROJECT` | gcp のみ | なし | `SECRET_BACKEND=gcp` のとき必須。**Docker 単体 / VPS（env 運用）では不要** |
| `DATABASE_URL_SECRET` | gcp のみ | なし | `SECRET_BACKEND=gcp` のとき必須となる Secret Manager のシークレット名。**env 運用では不要** |

> `GOOGLE_CLOUD_PROJECT` / `DATABASE_URL_SECRET` は **`SECRET_BACKEND=gcp` のときのみ必須**です
> （`SECRET_BACKEND=env` では使いません）。Cloud Run 運用の詳細は [cloud-run.md](./cloud-run.md) を参照。
>
> forwarding フェーズで追加した 5 変数（`CHATWORK_WEBHOOK_TOKEN` / `CHATWORK_API_TOKEN` / `SLACK_BOT_TOKEN` / `SLACK_DEFAULT_GROUP_CHANNEL_ID` / `SLACK_DEFAULT_DM_CHANNEL_ID`）は `ConfigSchema` で必須です。`env` 運用ではトークンの実値を直接注入します（**実値はイメージに焼き込まず、シェル履歴・ログに残さない**）。
> `SECRET_BACKEND=gcp` 運用では 3 つのトークンは Secret Manager から取得するため、env には実値ではなくシークレット名（`CHATWORK_WEBHOOK_TOKEN_SECRET` / `CHATWORK_API_TOKEN_SECRET` / `SLACK_BOT_TOKEN_SECRET`）を渡します（チャンネル ID 2 件は非秘密のため値をそのまま渡す）。詳細は [cloud-run.md](./cloud-run.md)。

### .env ファイルからの注入

多数の変数を渡す場合は `--env-file` も利用できます（`.env` はコミットしないこと）。

```bash
docker run --rm -p 8080:8080 --env-file .env chatwork-slack-bridge:local
```

サンプルは [`.env.example`](../../.env.example) を参照してください。

## 5. DB マイグレーション（コンテナ外で実施）

イメージは起動時に migration を行いません。スキーマ適用はソースを clone した環境から実施します。

```bash
DATABASE_URL='postgres://<USER>:<PASSWORD>@<HOST>:5432/<DB>?sslmode=require' pnpm db:migrate
```

- `drizzle-kit migrate` は冪等で、適用済み migration はスキップされます。

## 6. ローカル開発（compose）との使い分け

| 観点 | Docker 単体 / VPS（このページ） | compose（`docker-compose.yml`） |
|------|------|------|
| 用途 | 本番相当の単体配備 / 自前 VPS 運用 | ローカル開発・動作確認 |
| イメージ | 本番マルチステージ（`node dist`） | 同じ `Dockerfile` を `build:` で利用 |
| DB | 外部 PostgreSQL / Neon（`-e DATABASE_URL` で注入） | compose 内の `postgres:16` サービス（自動起動） |
| `SECRET_BACKEND` | `env`（`DATABASE_URL` を直接注入） | `env`（compose の `environment` で指定） |
| ポート | 既定 8080（イメージ既定 `PORT=8080`） | 3000（compose が `PORT=3000` を上書き、`3000:3000` を公開） |
| 起動 | `docker run -e ... -p 8080:8080 ...` | `docker compose up` |

ローカル開発では DB ごと立ち上がる compose が便利です。

```bash
docker compose up --build
# /health 確認（compose は 3000 番）
curl -i http://localhost:3000/health
```

> compose は `PORT=3000` を明示注入しているため 3000 番で listen します。
> 一方、`docker run` 単体ではイメージ既定の 8080 番です。両者でポートが異なる点に注意してください。

## 整合性メモ（変数の一致確認）

このページの環境変数は以下と一致しています。

- `src/config/env.ts`（`ConfigSchema`）: `DATABASE_URL` / `PORT` / `LOG_LEVEL` / `NODE_ENV` / `DB_HEALTH_TIMEOUT_MS` / `SECRET_BACKEND` / `GOOGLE_CLOUD_PROJECT` / `DATABASE_URL_SECRET` / `DB_POOLED` / `CHATWORK_WEBHOOK_TOKEN` / `CHATWORK_API_TOKEN` / `SLACK_BOT_TOKEN` / `SLACK_DEFAULT_GROUP_CHANNEL_ID` / `SLACK_DEFAULT_DM_CHANNEL_ID`。
- `Dockerfile`: runner の `ENV NODE_ENV=production` / `ENV PORT=8080` / `EXPOSE 8080`。
- `.github/workflows/deploy-cloud-run.yml`: Cloud Run は `SECRET_BACKEND=gcp` で `GOOGLE_CLOUD_PROJECT` / `DATABASE_URL_SECRET` / `DB_POOLED=true` / `CHATWORK_WEBHOOK_TOKEN_SECRET` / `CHATWORK_API_TOKEN_SECRET` / `SLACK_BOT_TOKEN_SECRET` / `SLACK_DEFAULT_GROUP_CHANNEL_ID` / `SLACK_DEFAULT_DM_CHANNEL_ID` を `--set-env-vars` に渡し、トークンの秘密の実値（`DATABASE_URL` / `*_TOKEN`）は Secret Manager 経由で取得（env への直書きなし）。Docker 単体 / VPS はこれと対照的に `SECRET_BACKEND=env` でトークンの実値を直接注入する運用です。

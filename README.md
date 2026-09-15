# Chatwork Slack Bridge

Chatwork のメッセージを Slack に集約し、Slack 上で内容確認・送信確認つき返信ができるブリッジ。
将来的には Claude / ChatGPT / MCP から履歴検索・要約・未返信チェック・返信案作成を行えるようにする。

Google Chat も任意で接続できる。ユーザー OAuth で指定した1スペースの新着テキストを取得し、Slack のスレッドへ転送する。返信には Slack 上の送信確認が必要。
Google Chat 連携は既定で無効。実サービス間の返信テストは未完了のため、有効化前に[検証手順](docs/google-chat.md)を実施する。

## 構成

```text
Chatwork Webhook → Bridge API (Hono) → PostgreSQL → Slack
Slack action/reply → Bridge API (Hono) → PostgreSQL → Chatwork API
Google Chat API ← polling → Bridge (Hono) → PostgreSQL → Slack
Slack confirmed reply → Bridge → Google Chat API (existing thread)
```

## 技術スタック

- Runtime: Node.js / Language: TypeScript
- HTTP framework: Hono
- DB: PostgreSQL / ORM: Drizzle / Validation: Zod
- Slack: `@slack/web-api` / Chatwork: 薄い自前 client
- Deploy: Docker（推奨デプロイ例: Cloud Run + Neon）

## ドキュメント

- [セットアップマニュアル](docs/setup-guide/README.md) — Slack アプリ / Chatwork Webhook / Secret Manager / GitHub 変数の設定手順
- [Google Chat の接続・運用手順](docs/google-chat.md) — ユーザー OAuth / 受信開始日時 / 返信許可 / 送信結果不明時の対応
- [システム概要](chatwork-slack-bridge-overview.md)
- [Cloud Run デプロイ手順](docs/deploy/cloud-run.md) / [Docker 単体デプロイ手順](docs/deploy/docker.md)
- [コーディングルール](docs/coding-rules.md)
- [レビュー基準](docs/review_rules.md)
- [開発ワークフロー（Issue → PR）](docs/issue-to-pr-workflow.md)

## ライセンス

[MIT License](LICENSE)

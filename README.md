# Chatwork Slack Bridge

Chatwork のメッセージを Slack に集約し、Slack 上で内容確認・送信確認つき返信ができるブリッジ。
将来的には Claude / ChatGPT / MCP から履歴検索・要約・未返信チェック・返信案作成を行えるようにする。

> ⚠️ 開発初期段階です。現時点では設計ドキュメントのみで、実装はこれからです。

## 構成

```text
Chatwork Webhook → Bridge API (Hono) → PostgreSQL → Slack
Slack action/reply → Bridge API (Hono) → PostgreSQL → Chatwork API
```

## 技術スタック

- Runtime: Node.js / Language: TypeScript
- HTTP framework: Hono
- DB: PostgreSQL / ORM: Drizzle / Validation: Zod
- Slack: `@slack/web-api` / Chatwork: 薄い自前 client
- Deploy: Docker（推奨デプロイ例: Cloud Run + Neon）

## ドキュメント

- [セットアップマニュアル](docs/setup-guide/README.md) — Slack アプリ / Chatwork Webhook / Secret Manager / GitHub 変数の設定手順
- [システム概要](chatwork-slack-bridge-overview.md)
- [Cloud Run デプロイ手順](docs/deploy/cloud-run.md) / [Docker 単体デプロイ手順](docs/deploy/docker.md)
- [コーディングルール](docs/coding-rules.md)
- [レビュー基準](docs/review_rules.md)
- [開発ワークフロー（Issue → PR）](docs/issue-to-pr-workflow.md)

## ライセンス

[MIT License](LICENSE)

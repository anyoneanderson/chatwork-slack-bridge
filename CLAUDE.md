# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Chatwork Slack Bridge — Chatwork のやり取りを Slack に集約する中継サーバー（OSS 配布想定）。
Chatwork Webhook を受信して PostgreSQL に保存し Slack へ転送、Slack 上での送信確認を経て Chatwork API へ返信する。

詳細は [chatwork-slack-bridge-overview.md](chatwork-slack-bridge-overview.md) を参照。

## 技術スタック

- Runtime: Node.js / Language: TypeScript
- HTTP framework: Hono
- DB: PostgreSQL / ORM: Drizzle / Validation: Zod
- Slack: `@slack/web-api` / Chatwork: 薄い自前 client
- Queue: DB-backed queue / Deploy: Docker

外部サービス依存は `src/adapters/{chatwork,slack,queue,secrets,ai}/` に閉じ込める。

## コーディングルール

実装時のコーディングルールは以下のファイルに従ってください:
- [docs/coding-rules.md](docs/coding-rules.md) — 品質ルール集
- [docs/review_rules.md](docs/review_rules.md) — コードレビュー・セカンドオピニオン用のレビュー基準

## Development Workflow

開発フロー（Issue → 実装 → PR）は以下のファイルに従ってください:
- [docs/issue-to-pr-workflow.md](docs/issue-to-pr-workflow.md) — 開発ワークフロー

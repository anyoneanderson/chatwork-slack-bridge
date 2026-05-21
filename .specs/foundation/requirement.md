# 要件定義書 - foundation（プロジェクト基盤 / 動く器）

> 対象 Issue: [#1 \[Phase 1\] foundation — プロジェクト基盤（器）の構築](https://github.com/anyoneanderson/chatwork-slack-bridge/issues/1)
> 参照: `chatwork-slack-bridge-overview.md`（アダプタ境界 / 技術スタック / Phase 1）, `docs/coding-rules.md`, `docs/review_rules.md`

## 1. 概要

業務ロジック（Chatwork/Slack 連携）の前段となる「動く器」を整備する。以降の全フェーズ
（forwarding / slack-reply / ops-safety / cloud-deploy / ai-mcp）はこの基盤の上に乗る。

本フェーズのゴールは、**ローカルで起動でき、最小限のヘルスチェックが通り、品質ゲート
（lint / typecheck / test）が回る walking skeleton** を用意すること。業務テーブルや業務
エンドポイントは含めず、アダプタ境界のディレクトリ構成と DB 接続・設定取得・ロギングの
土台のみを作る。

### スコープ外（本 Issue では作らない）

- Chatwork / Slack の業務ロジック（→ forwarding 以降）
- 本番デプロイ設定（Dockerfile 本番最適化 / Cloud Run / Secret Manager → cloud-deploy）
- 各業務テーブル（`chatwork_rooms` 等。使う機能の spec で migration を追加する方針）
- Slack 送信 UI / AI プロバイダ選定（slack-reply / ai-mcp で決定）

## 2. 機能要件

### [REQ-001] ヘルスチェックエンドポイント
- `GET /health` を提供し、アプリが正常稼働かつ DB に疎通できる場合に `200` を返す。
- DB 疎通確認は軽量なクエリ（`SELECT 1`）で行う。
- DB 疎通の確認には **bounded timeout**（`DB_HEALTH_TIMEOUT_MS`、既定 2000ms）を設け、DB が
  失敗ではなく無応答（ハング）の場合でもタイムアウトで打ち切り、リクエストが詰まらないようにする。
- DB 疎通に失敗（またはタイムアウト）した場合は `503` を返し、構造化ログにエラーを記録する
  （接続文字列は出力しない）。
- レスポンスは JSON（例: `{ "status": "ok", "db": "ok" }`）。
- ユーザーストーリー: 運用者として、デプロイ先（Docker / Cloud Run）の healthcheck・ローカル
  起動確認に使え、DB 無応答時もすぐ異常を返すエンドポイントが欲しい。

### [REQ-002] Hono アプリ雛形とルーティング基盤
- Hono アプリのエントリポイント（`src/app`）を用意し、HTTP サーバを起動できる。
- ルートは `src/app/routes/` に分離し、`/health` をマウントする。
- 404 / 例外時に構造化ログを出力する共通エラーハンドリングを持つ。
- ユーザーストーリー: 開発者として、後続の Webhook / Slack エンドポイントを追加できる
  薄いルーティング土台が欲しい。

### [REQ-003] config / secret adapter（環境変数実装）
- `SecretProvider` インターフェースを `src/adapters/secrets/` に定義し、環境変数実装
  （`.env` ベース）を提供する。取得キーは Phase 1 では固定のため **union 型**で型付けし、
  キーの typo をコンパイル時に検出する。
- アプリ起動時に必要な設定（`DATABASE_URL`, `PORT`, `LOG_LEVEL`, `NODE_ENV`,
  `DB_HEALTH_TIMEOUT_MS`）を **Zod** でバリデーションする。
- 検証は `loadConfig` が担い、不正・不足時は **`ConfigError` を throw** する（`process.exit`
  はしない）。プロセス終了の責務は `src/index.ts` が持ち、`ConfigError` を捕捉して構造化
  ログ（値そのものは含めない）を出力してから `process.exit(1)` する。この責務分担により
  `loadConfig` 単体をテスト可能にする。
- `JSON.parse` 結果や環境変数を信用せず、必ず Zod スキーマで検証してから使う。
- Secret Manager 実装は本フェーズに含めない（cloud-deploy に回す）。
- ユーザーストーリー: 開発者として、秘密情報の取得経路を一箇所（adapter）に閉じ込め、
  後でクラウド向け実装に差し替えられるようにしたい。

### [REQ-004] Drizzle DB 接続・スキーマ・マイグレーション基盤
- `postgres.js` ドライバ（`drizzle-orm/postgres-js`）で DB 接続を確立する。
- `src/db/schema.ts` を用意する（本フェーズでは業務テーブルを定義せず、空または最小の土台）。
- Drizzle Kit によるマイグレーション基盤（`drizzle.config.ts`, `migrate` スクリプト）を整備する。
- **空スキーマ時の期待動作を明示する**:
  - `pnpm db:generate`: 定義テーブルが無いため新規 migration を生成せず**変更なしで成功**
    する（明示的な no-op として扱い、エラーにしない）。
  - `pnpm db:migrate`: 適用すべき migration が無くても**成功**する。Drizzle の migrations
    管理用メタテーブル（`__drizzle_migrations` 等）が作成されることは許容する。
  - この動作を受け入れ条件とし、後続フェーズが migration を追加するだけで機能する状態にする。
- DB クライアントは secret adapter 経由で取得した `DATABASE_URL` を使う。
- ユーザーストーリー: 開発者として、後続フェーズで `migration` を追加するだけでテーブルを
  足せる状態にしておきたい。

### [REQ-005] アダプタ境界のディレクトリ構成
- 以下のディレクトリ構成を作成する（中身は本フェーズでは雛形/空でよい）:
  ```text
  src/
    adapters/   # chatwork, slack, queue, secrets, ai
    app/        # routes, services
    db/         # schema.ts, migrations/
  ```
- `src/app/routes/` `src/app/services/` から外部 SDK を直接呼ばず、アダプタ経由にする規約を守れる構成にする。
- ユーザーストーリー: 開発者として、OSS として育てるためのアダプタ境界を最初から固定したい。

### [REQ-006] 構造化ロガー（pino）
- `pino` ベースの構造化ロガーを `src/` 共通モジュールとして用意する。
- ログは JSON 形式で出力し、ログレベルは設定（`LOG_LEVEL`）で制御する。
- API トークン・接続文字列・メッセージ全文を出力しない方針を**実装条件として**組み込む:
  - pino の `redact` に `DATABASE_URL` 相当のキー（および将来のトークン系キー）を登録する。
  - 設定検証エラーは値そのものを保持しない形（キー名と理由のみ）でログ化する。
  - 「TSDoc / レビュー基準での担保」だけに依存しない。
- ユーザーストーリー: 運用者として、Cloud Logging 等で扱える構造化ログが最初から欲しい。

### [REQ-007] ローカル起動環境（docker-compose）
- `docker-compose.yml` で app + PostgreSQL をローカル起動できる。
- アプリ用 `Dockerfile`（開発/起動用。本番最適化は cloud-deploy）を用意する。
- `depends_on` に PostgreSQL の healthcheck 条件を付け、DB 起動後に app が立ち上がる。
- ユーザーストーリー: 開発者として、`docker compose up -d` だけでローカル一式が起動してほしい。

### [REQ-008] 開発ツールチェーンと npm スクリプト
- パッケージマネージャは **pnpm**。
- `tsconfig.json` を strict モードで用意する。
- Biome（lint / format）、Vitest（test）をセットアップする。
- `pnpm dev` / `pnpm build` / `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm db:migrate` を提供する。
- ユーザーストーリー: 開発者として、統一されたコマンドで開発・検証ができるようにしたい。

### [REQ-009] CI 雛形（lint / typecheck / test）
- GitHub Actions の workflow で `pnpm lint` / `pnpm typecheck` / `pnpm test` を実行する。
- 秘密情報を workflow に直接書かない（必要なら Secrets 名のみ）。
- 本番デプロイ workflow は本フェーズに含めない（cloud-deploy）。
- ユーザーストーリー: 開発者として、PR で品質ゲートが自動で回ってほしい。

## 3. 非機能要件

### [NFR-001] 型安全・品質ゲート
- TypeScript strict（`strict: true`）。`pnpm typecheck`（`tsc --noEmit`）がパスする。
- Biome の lint がパスする。未使用 import / デッドコード / `console.log` を残さない。

### [NFR-002] テスト
- テストフレームワークは **Vitest**。
- ユニットテストカバレッジ **80% 以上** を維持する（基盤フェーズで対象となるロジック
  — config バリデーション、health ハンドラ、secret adapter — を中心に）。
- **カバレッジ閾値の有効化タイミング**: テストファイルが存在しない初期化フェーズで CI/ゲートが
  落ちないよう、Phase 1 は `--passWithNoTests` 相当で扱い、coverage 80% の閾値はテストを追加
  する Phase 2（T012）以降で有効化する。
- 外部依存（DB 等）はアダプタ境界でモックし、ユニットテストを外部ネットワークに依存させない。

### [NFR-003] セキュリティ
- 秘密情報（`DATABASE_URL` 等）は secret adapter 経由で取得する。ソース・workflow・イメージに直接書かない。
- イメージレイヤや `ENV` に秘密情報を焼き込まない（実行時注入）。
- ログに接続文字列・トークン・メッセージ全文を出力しない。
- 公開エンドポイントは必要最小限（本フェーズは `/health` のみ）。

### [NFR-004] 構造化ログ
- すべてのログは JSON 構造化形式（pino）。`console.log` を本番ロジックで使わない。

### [NFR-005] ローカル再現性
- `pnpm install && docker compose up -d` でローカル起動できる。
- `/health` が DB 疎通込みで `200` を返す。

### [NFR-006] 拡張性（アダプタ境界）
- 外部サービス依存は `src/adapters/{name}/` に閉じ込め、後続フェーズで実装を差し替えられる。

## 4. 制約事項

### [CON-001] 技術スタック固定
- Runtime: Node.js / Language: TypeScript / HTTP: Hono / DB: PostgreSQL /
  ORM: Drizzle / Validation: Zod。`chatwork-slack-bridge-overview.md` の技術スタックに従う。

### [CON-002] パッケージマネージャ
- pnpm を使用する（Issue 指定）。

### [CON-003] DB ドライバ
- Drizzle の DB 接続は **postgres.js**（`drizzle-orm/postgres-js`）を基準にする
  （将来の Cloud Run + Neon pooled connection と整合。ユーザー決定）。

### [CON-004] ロガー
- 構造化ロガーは **pino** を基準にする（ユーザー決定 / coding-rules 例示）。

### [CON-005] secret adapter のスコープ
- 本フェーズは `SecretProvider` インターフェース + 環境変数（.env）実装のみ。
  Secret Manager 実装は cloud-deploy に回す（ユーザー決定）。

### [CON-006] DB スキーマ方針
- 主キーは `bigint generated always as identity`（`serial`/`bigserial` 禁止）。
- 業務テーブルは本フェーズで作らない（使う機能の spec で migration を足す）。

### [CON-007] OSS / 秘密情報
- 実 Slack チャンネル ID / Chatwork ルーム ID、クライアント名・本文を含むログ・fixture を
  コミットしない。`.env` はコミットせず `.env.example` のみ公開する。

### [CON-008] Git / ブランチ
- フィーチャーブランチで作業し `main` へ直接コミットしない。コミットは Conventional Commits（英語）。

## 5. 前提条件

### [ASM-001] ランタイムバージョン
- Node.js 22 LTS を想定する（`engines` / Docker ベースイメージのタグ固定で表現）。

### [ASM-002] PostgreSQL バージョン
- PostgreSQL 16 を想定する（`NULLS NOT DISTINCT` 等 PG15+ 機能を後続フェーズで利用可能にするため）。

### [ASM-003] 開発環境
- 開発者のマシンに Docker / Docker Compose と pnpm が利用可能である。

### [ASM-004] リポジトリ
- GitHub `anyoneanderson/chatwork-slack-bridge`（public）。CI は GitHub Actions。

## 6. 受け入れ基準（Issue #1 準拠）

- [ ] `pnpm install && docker compose up -d` でローカル起動できる
- [ ] `/health` が `200` を返す（DB 疎通含む）
- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm test` が通る
- [ ] アダプタ境界のディレクトリ構成（`src/adapters/{chatwork,slack,queue,secrets,ai}` /
      `src/app/{routes,services}` / `src/db`）ができている

## 7. 用語集

| 用語 | 定義 |
|------|------|
| アダプタ境界 | 外部サービス依存（Chatwork/Slack/queue/secrets/ai）を `src/adapters/{name}/` に閉じ込める設計方針 |
| secret adapter | 秘密情報・設定値の取得経路を抽象化するモジュール。本フェーズは環境変数実装のみ |
| walking skeleton | 業務機能はないが、起動〜ヘルスチェック〜CI まで一気通貫で動く最小構成 |
| 動く器 | 後続フェーズの業務ロジックを乗せる前提となる、起動可能な基盤 |

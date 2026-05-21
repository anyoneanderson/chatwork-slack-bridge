# 要件定義書 - cloud-deploy（本番デプロイのレール構築 / walking skeleton）

> 対象 Issue: [#2 \[Phase 2\] cloud-deploy — 本番デプロイのレール構築（walking skeleton）](https://github.com/anyoneanderson/chatwork-slack-bridge/issues/2)
> 参照: `chatwork-slack-bridge-overview.md`（推奨インフラ / デプロイ方針 / CI/CD 公開方針 / Phase 5）, `docs/coding-rules.md`（コンテナ / デプロイ・セキュリティ）, `docs/review_rules.md`
> 前提フェーズ: `.specs/foundation/`（#1 完了済み。`/health`・secret adapter・Dockerfile・config・DB クライアントが既存）

## 1. 概要

`/health` だけの最小アプリを本番（Cloud Run + Neon PostgreSQL）に通し、**build → deploy →
Secret 取得 → DB 接続**のパイプラインを確立する。以降の全機能（forwarding / slack-reply /
ops-safety / ai-mcp）はこの実証済み経路に乗せる。

本フェーズのゴールは、**main への push をトリガーに GitHub Actions がコンテナをビルドして
Artifact Registry に push し、Cloud Run へデプロイ。デプロイ後の `/health` が本番で Neon に
疎通して `200` を返す walking skeleton** を用意すること。業務ロジック・業務テーブルは追加しない。

実シークレットは現時点で `DATABASE_URL` のみ。Chatwork / Slack トークンは forwarding(#3) で追加する。

### スコープ（含む）

- Cloud Run 向け本番 `Dockerfile`（multi-stage / 非 root / ベースイメージのタグ固定 /
  コンパイル済み JS 実行）
- secret adapter の Secret Manager 実装（`@google-cloud/secret-manager`、まず `DATABASE_URL`）
- Neon PostgreSQL（pooled connection）への接続対応（postgres.js のオプション調整）
- `.github/workflows/deploy-cloud-run.yml`（Workload Identity Federation /
  build → Artifact Registry push → Cloud Run deploy / `if: github.repository == ...` ガード）
- `docs/deploy/cloud-run.md` / `docs/deploy/docker.md`

### スコープ外（本 Issue では作らない）

- Cloud Tasks adapter（→ ops-safety #5）
- Chatwork / Slack トークンの Secret 追加（→ forwarding #3 で追加）
- 業務テーブル・業務エンドポイント（→ forwarding 以降）
- GCP リソース（プロジェクト / WIF プール / Artifact Registry / Secret / Neon）の作成自動化
  （手動プロビジョニングを前提とし、手順は docs に記載。本 Issue はアプリ側のレール）

## 2. 機能要件

### [REQ-001] 本番向け multi-stage Dockerfile
- Cloud Run で動作する本番 `Dockerfile` を用意する（既存の開発/起動用 Dockerfile を本番最適化）。
- **multi-stage build**: ビルドステージで依存導入と `pnpm build`（TypeScript → `dist/`）を行い、
  実行ステージにはコンパイル済み JS と本番依存（prod dependencies）のみを置く。
- 実行は `node`（`tsx` ではなくコンパイル済み JS のエントリポイント）で行う。
- **非 root ユーザー**（`node`）で実行する。
- ベースイメージはバージョンタグ固定（`node:22-slim` 等、`latest` 禁止）。
- イメージ / `ENV` に秘密情報を焼き込まない（実行時に Secret Manager から取得）。
- Cloud Run が注入する `PORT`（既定 8080）で listen する（config の `PORT` 経由で解決）。
- ユーザーストーリー: 運用者として、Cloud Run にそのまま載せられる最小・安全な本番イメージが欲しい。

### [REQ-002] Secret Manager secret adapter 実装
- `SecretProvider` インターフェース（foundation で定義済み）に対する **Google Cloud
  Secret Manager 実装**を `src/adapters/secrets/` に追加する。
- 既存の `SecretProvider.get(key)` は**同期 IF** のため、Secret Manager 実装は
  **起動時に対象シークレットを非同期でプリフェッチ**し、取得済みの値を保持した**同期
  SecretProvider** を返す factory（`createGcpSecretProvider(...)`）として提供する。
- Secret Manager から取得するのは**秘密情報キーのみ**（本フェーズは `DATABASE_URL`）。
  非秘密の設定キー（`PORT` / `LOG_LEVEL` / `NODE_ENV` / `DB_HEALTH_TIMEOUT_MS` 等）は
  引き続き環境変数（内部に持つ `EnvSecretProvider`）から解決する。
- secret backend は環境変数で切り替える（`SECRET_BACKEND`: `env`（既定）/ `gcp`）。
  `env` のときは既存の `EnvSecretProvider` をそのまま使い、ローカル / docker-compose の挙動を変えない。
- Secret Manager の参照に必要な情報（プロジェクト ID、シークレット名）は環境変数で受け取り、
  値そのものはコード・workflow・イメージに直書きしない。
- Cloud Run 実行サービスアカウントの ADC（Application Default Credentials）で認証する
  （SA JSON 鍵をイメージ・環境変数に置かない）。
- **取得失敗時は起動を中断する**: 対象シークレットが存在しない / payload が空の場合は
  env へフォールバックせず**明示的にエラーを throw** し、不正な状態での起動を防ぐ
  （壊れた / 未設定の Secret を「取得成功」と誤認しない）。
- **堅牢性**: Secret Manager 呼び出しに **bounded timeout**（既定 5000ms）と**リトライ**
  （指数バックオフ、最大 2 回）を設け、起動時ハング・一時障害に耐える。失敗ログには
  シークレット名・値・接続文字列を含めない（キー区分と理由のみ）。
- ユーザーストーリー: 開発者として、ローカルは `.env`、Google Cloud では Secret Manager と、
  同じ `SecretProvider` 抽象のまま実装だけ差し替えられるようにしたい。

### [REQ-003] Neon PostgreSQL（pooled connection）対応
- 既存 DB クライアント（`drizzle-orm/postgres-js`）を、Neon の **pooled connection** で
  正しく動作するように調整する。
- pooled connection（PgBouncer transaction mode）では **prepared statements が使えない**ため、
  pooled 利用時は postgres.js の `prepare: false` を設定できるようにする
  （設定キー `DB_POOLED`: 既定 `false`。`true` で `prepare: false`）。
- SSL は接続文字列（Neon の `sslmode=require` 付き URL）で解決し、ローカル compose
  （SSL なし）と本番（SSL 必須）を同一コードで扱えるようにする。
- 既存の `/health`（`ping(timeoutMs)`）が、ローカル PostgreSQL でも Neon pooled でも
  同じく疎通確認できる。
- ユーザーストーリー: 運用者として、Cloud Run + Neon の pooled connection 構成で
  prepared statement エラーを起こさず DB 疎通したい。

### [REQ-004] Cloud Run デプロイ workflow
- `.github/workflows/deploy-cloud-run.yml` を追加する。
- トリガー: `main` への push（マージ時の自動デプロイ）/ `pull_request`（quality-gate のみ）/
  `workflow_dispatch`（手動）。
- **fork 事故防止ガード**: deploy ジョブに `if: github.repository == 'anyoneanderson/chatwork-slack-bridge'`
  （かつ PR では deploy せず quality-gate まで）を設ける。
- **認証**: Workload Identity Federation（`google-github-actions/auth@v2`、`permissions.id-token: write`）。
  サービスアカウント JSON 鍵を GitHub Secrets に置かない。
- **パイプライン**（main push / 手動時）:
  1. quality-gate（`pnpm install --frozen-lockfile` → `lint` / `typecheck` / `test`）
  2. WIF 認証 → `gcloud` セットアップ
  3. Secret Manager から本番 `DATABASE_URL` を取得し `pnpm db:migrate`（空スキーマでも成功 / 後続フェーズで有効化）
  4. Docker イメージを build（buildx）し、**git commit SHA タグ**で Artifact Registry に push
  5. その image を `gcloud run deploy`（実行 SA / `PORT` / Secret 参照用 env を指定）
  6. デプロイ後、`/health` が `200` を返すことを検証する
- **デプロイ対象タグは git SHA のみ**とする。`latest` タグは可読性のための補助タグとして
  push してよいが、`gcloud run deploy` で参照するのは SHA タグに固定し、ロールバック・監査の
  追跡性を担保する。
- migration 用に runner で一時取得する `DATABASE_URL` は、取得直後に GitHub Actions の
  `::add-mask::` でマスクする（Secret Manager 由来の値は GitHub secrets コンテキストではなく
  自動マスクされないため）。
- 秘密情報は workflow に直書きしない。GitHub repository **variables / secrets** には
  **Secret 名・リソース名・設定値のみ**を置く（秘密の実値は Secret Manager に閉じ込める）。
- ユーザーストーリー: 開発者として、main にマージするだけで品質ゲートを経て Cloud Run へ
  自動デプロイされ、ロールバック可能な SHA タグ付きイメージが残ってほしい。

### [REQ-005] デプロイドキュメント
- `docs/deploy/cloud-run.md`: Google Cloud 向け手順（必要な GCP リソース、WIF セットアップ、
  Artifact Registry、Secret Manager への `DATABASE_URL` 登録、GitHub variables/secrets 一覧、
  リージョン、実行 SA 権限 `roles/secretmanager.secretAccessor` 等）。
  - **Neon のバックアップ / リカバリ確認**（PITR / branch によるリストア可否、復旧手順の所在）
    と、デプロイ後の最低限の運用確認項目（`/health` 200・リビジョン確認・ロールバック手順）を含める。
- `docs/deploy/docker.md`: Docker 単体 / VPS 向け手順（イメージの build / run、必要な環境変数、
  `DATABASE_URL` の渡し方）。
- いずれも**実値・実 ID・クライアント名を含めず**、変数名・プレースホルダのみで記述する。
- ユーザーストーリー: OSS 利用者として、自分の環境に置き換えるだけでデプロイできる手順が欲しい。

### [REQ-006] 起動シーケンスの非同期化
- secret 取得が非同期になりうる（Secret Manager プリフェッチ）ため、`src/index.ts` の
  起動処理を **async bootstrap**（`main()`）に整理し、secret provider 初期化 →
  `loadConfig` → DB クライアント生成 → サーバ起動の順を await で直列化する。
- secret provider 初期化・config 検証の失敗時は構造化ログ（**値そのものは出さない**）を
  出力してから `process.exit(1)` する（プロセス終了の責務は index.ts が持つ既存方針を踏襲）。
- 既存の SIGTERM/SIGINT graceful shutdown（`db.close()`）を維持する。
- ユーザーストーリー: 開発者として、secret backend が env でも gcp でも同じ起動フローで
  安全に立ち上がってほしい。

## 3. 非機能要件

### [NFR-001] セキュリティ（秘密情報・認証）
- 秘密情報（`DATABASE_URL`）はイメージレイヤ・`ENV`・ソース・workflow に焼き込まない。
  実行時に Secret Manager から取得する。
- GCP 認証は **Workload Identity Federation** を優先し、SA JSON 鍵を発行・保管しない。
- ログに接続文字列・secret 値を出さない（既存 pino redact / config error の値非保持を踏襲）。
- 公開エンドポイントは `/health` のみ（本フェーズで増やさない）。

### [NFR-002] イメージ最小化・非 root・タグ固定
- 本番イメージは multi-stage で実行に不要なビルド依存を含めない。
- 非 root ユーザーで実行。ベースイメージはタグ固定（`latest` 禁止）。
- **イメージ脆弱性スキャン**（`docs/coding-rules.md` Docker `[SHOULD]`）は本フェーズで
  workflow に組み込む（例: Trivy。CRITICAL/HIGH 検出時の扱いを決める）か、組み込まない場合は
  「スコープ外」とする判断を技術的決定事項に明記する（暗黙にしない）。

### [NFR-003] デプロイ再現性・ロールバック
- `pnpm install --frozen-lockfile` で依存を固定し、CI と本番の再現性を担保する。
- イメージは **git commit SHA タグ**で push し、過去リビジョンへロールバック可能にする。
- main への push で自動デプロイが回る（手動 `workflow_dispatch` も可）。

### [NFR-004] 型安全・品質ゲート維持
- 既存の `pnpm lint` / `pnpm typecheck` / `pnpm test`（カバレッジ **80% 以上**）を維持する。
- 追加実装（Secret Manager adapter / DB pooled 対応 / 起動の async 化）にユニットテストを足し、
  カバレッジ閾値を下回らない。

### [NFR-005] 構造化ログ
- すべてのログは JSON 構造化（pino）。`console.log` を本番ロジックで使わない。

### [NFR-006] アダプタ境界の維持
- Secret Manager 依存（`@google-cloud/secret-manager`）は `src/adapters/secrets/` に閉じ込め、
  `app`/`config`/`db` から直接 SDK を呼ばない。

### [NFR-007] secret 取得の堅牢性
- Secret Manager 取得には bounded timeout（既定 5000ms）とリトライ（指数バックオフ・最大 2 回）を設ける。
- 対象シークレットが missing / 空 payload の場合は env フォールバックせず起動を中断する（REQ-002）。
- 失敗ログにシークレット名・値・接続文字列を含めない。

## 4. 制約事項

### [CON-001] アダプタ境界・既存契約の維持
- `SecretProvider` インターフェース（`get(key: SecretKey): string | undefined`）の同期契約を壊さない。
  Secret Manager の非同期取得は factory のプリフェッチで吸収する。

### [CON-002] OSS / 秘密情報の非コミット
- 実 GCP プロジェクト ID / 実 Neon 接続文字列 / 実 Slack・Chatwork ID / クライアント名・本文を
  コミットしない。workflow・docs には Secret 名・変数名・プレースホルダのみを書く。

### [CON-003] Workload Identity Federation 優先
- GitHub Actions → GCP の認証は WIF を使い、サービスアカウント JSON 鍵を使わない
  （`docs/coding-rules.md` `[SHOULD] HTTPS / Workload Identity`）。

### [CON-004] リージョン / 命名規約
- リージョンは `asia-northeast1` を既定とする（既存 Zenchaine プロジェクト群に整合）。
- 設定値は GitHub repository variables（`vars.*`）、秘密の実値は Secret Manager に置く方針に従う。

### [CON-005] フェーズスコープ
- Cloud Tasks adapter（ops-safety）/ Chatwork・Slack トークン（forwarding）は本フェーズで追加しない。

### [CON-006] 技術スタック固定（foundation 準拠）
- Node.js 22 LTS / PostgreSQL 16（Neon）/ pnpm / Hono / Drizzle（postgres.js）/ Zod。
  foundation で確定したスタックを変更しない。

### [CON-007] Git / ブランチ
- フィーチャーブランチで作業し `main` へ直接コミットしない。コミットは Conventional Commits（英語）。
- gh / git 操作は **anyoneanderson** アカウントで行う（実行前に `gh api user --jq '.login'` で確認）。

### [CON-008] 公開エンドポイントの認証ゲート（後続フェーズへの制約）
- 本フェーズは `/health` のみ公開のため Cloud Run の `--allow-unauthenticated` を許容する。
- ただし同一サービスに業務エンドポイント（Webhook / Slack）を追加する**前に**、署名検証・認可を
  必須化することを後続フェーズ（forwarding 以降）の前提制約として明記する（`docs/coding-rules.md`
  `[MUST] Webhook / リクエスト署名検証`・`[MUST] 公開エンドポイントの最小化` を踏襲）。

## 5. 前提条件

### [ASM-001] GCP リソースの事前プロビジョニング
- GCP プロジェクト、Artifact Registry リポジトリ、Workload Identity プール / プロバイダ、
  デプロイ用 SA・Cloud Run 実行用 SA、`DATABASE_URL` の Secret Manager シークレットは
  **手動で作成済み**である（手順は `docs/deploy/cloud-run.md` に記載）。本 Issue はアプリ側のレール整備。

### [ASM-002] Neon PostgreSQL
- Neon の PostgreSQL（pooled connection 文字列、`sslmode=require`）が作成済みで、
  その接続文字列が Secret Manager に登録済みである。

### [ASM-003] GitHub 設定
- GitHub repository variables / secrets（プロジェクト ID・リージョン・サービス名・WIF プロバイダ・
  デプロイ SA・実行 SA・Artifact Registry リポジトリ・`DATABASE_URL` シークレット名）が設定済みである。

### [ASM-004] ランタイム
- Node.js 22 LTS / PostgreSQL 16。Cloud Run は `PORT` を注入する（既定 8080）。

## 6. 受け入れ基準（Issue #2 準拠）

- [ ] Cloud Run に `/health` がデプロイされ、Neon への DB 疎通が本番で確認できる（`/health` が `200`）
- [ ] シークレット（`DATABASE_URL`）は Secret Manager 経由で取得され、イメージ・workflow に直書きされていない
- [ ] GitHub Actions で `main` push → Cloud Run へのデプロイが回る
- [ ] イメージは git commit SHA タグで Artifact Registry に push されている
- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm test`（カバレッジ 80% 以上）が通る
- [ ] `docs/deploy/cloud-run.md` / `docs/deploy/docker.md` が実値を含まずに整備されている

## 7. 用語集

| 用語 | 定義 |
|------|------|
| WIF（Workload Identity Federation） | GitHub Actions が SA JSON 鍵なしで GCP に認証する仕組み |
| Artifact Registry | コンテナイメージを格納する GCP のレジストリ |
| pooled connection | Neon が提供する PgBouncer 経由の接続。prepared statement 非対応のため `prepare: false` が必要 |
| Secret Manager | GCP のシークレット管理サービス。実行時に `DATABASE_URL` 等を取得する |
| ADC（Application Default Credentials） | Cloud Run 実行 SA の権限で GCP API を呼ぶための既定認証情報 |
| walking skeleton | 業務機能はないが、build〜deploy〜本番 `/health`〜DB 疎通まで一気通貫で動く最小構成 |

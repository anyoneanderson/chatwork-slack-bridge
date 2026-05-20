# コーディングルール

> spec-rules-init により自動生成。
> 出典: chatwork-slack-bridge-overview.md + インストール済みスキル（typescript-best-practices, zod, drizzle-orm-patterns, postgresql-table-design, docker）
> 生成日時: 2026-05-20 17:09（2026-05-20 スキル群でルール改訂）

本プロジェクト（Chatwork Slack Bridge）は OSS として配布する想定の中継サーバーです。
技術スタック: **Node.js / TypeScript / Hono / PostgreSQL / Drizzle / Zod / @slack/web-api**。
業務チャットを扱うため、**署名検証・送信確認・秘密情報の取り扱い**を最優先のルールとします。

## テスト基準

### [MUST] カバレッジ閾値
- ユニットテストカバレッジは **80% 以上** を維持すること
- 出典: ユーザー指定

### [MUST] テストフレームワーク
- すべてのテストに **Vitest** を使用すること
- 出典: 技術スタック（TypeScript / Node.js 標準構成）

### [MUST] 重要ロジックのテスト
- 以下は必ずテストを書くこと:
  - Chatwork Webhook 署名検証
  - Slack request 署名検証
  - メッセージ重複チェック（`unique (chatwork_room_id, chatwork_message_id)` 相当のロジック）
  - Chatwork 送信フロー（送信確認 → 送信 → 結果記録）
- 出典: chatwork-slack-bridge-overview.md（セキュリティ / 主要ユースケース）

### [SHOULD] テスト命名規則
- 実装ではなく振る舞いを記述する
- パターン: `{期待される振る舞い} when {条件}`

### [SHOULD] 外部依存のモック
- Chatwork API / Slack API / DB へのアクセスはアダプタ境界でモックし、ユニットテストを外部ネットワークに依存させない

### [MAY] E2Eテスト
- Webhook 受信 → Slack 投稿 → Chatwork 送信の主要フローに統合テストを実施する

## コード品質

### [MUST] Lint・型チェック
- コミット前に lint（ESLint または Biome）がパスすること
- コミット前に `tsc --noEmit`（型チェック）がパスすること
- TypeScript は strict モードを有効にすること（`tsconfig.json` で `strict: true`）

### [MUST] 命名規則
- ファイル名: **kebab-case**（例: `chatwork-client.ts`, `verify-signature.ts`）
- 変数・関数: **camelCase**
- クラス・型・インターフェース: **PascalCase**
- 定数: **UPPER_SNAKE_CASE**
- DB カラム / SQL: **snake_case**（PostgreSQL 慣習。overview のスキーマに準拠）

### [MUST] アダプタ境界の遵守
- 外部サービス依存（Chatwork / Slack / queue / secrets / ai）は `src/adapters/{name}/` に閉じ込めること
- `src/app/routes/`・`src/app/services/` から外部 SDK を直接呼ばず、必ずアダプタ経由にする
- 理由: OSS として育てるため、特定クラウド・特定サービスへの依存を薄く保つ
- 出典: chatwork-slack-bridge-overview.md（アダプタ境界）

### [SHOULD] ディレクトリ構成
- 以下の構成に従う:
  ```text
  src/
    adapters/   # chatwork, slack, queue, secrets, ai
    app/        # routes, services
    db/         # schema.ts, migrations/
  ```

### [SHOULD] import形式
- パスエイリアス `@/` を基本とし、相対パスの深い遡り（`../../../`）を避ける

### [SHOULD] 未使用importの禁止
- コミット前にすべての未使用 import を削除すること

### [SHOULD] マジックナンバー・文字列の排除
- ステータス値（`open` / `pending` / `confirm` 等）や設定値は名前付き定数または enum/union 型として定義する

### [SHOULD] 型安全（不正な状態を型で排除する）
- ステータス等の固定値は **const assertion + union 型** で定義し、配列と型を同期させる
  ```ts
  const MESSAGE_STATUS = ['open', 'done'] as const;
  type MessageStatus = typeof MESSAGE_STATUS[number]; // 'open' | 'done'
  ```
- 相互排他な状態は **discriminated union** で表現する（例: outbound 送信結果 `{ status: 'sent'; chatworkMessageId } | { status: 'failed'; error }`）。`boolean` フラグの組み合わせで不正な状態を許さない
- 取り違えやすい識別子は **branded type** を使う（`ChatworkRoomId`, `ChatworkMessageId`, `SlackChannelId` を素の `string` と区別する）
- `switch` は **`never` による網羅性チェック** で分岐漏れをコンパイル時に検出する
- 型は **`z.infer`** で Zod スキーマから導出し、型とスキーマを二重定義しない
- 出典: skill/typescript-best-practices, skill/zod

### [SHOULD] 命名の明確さ
- `data`, `info`, `temp`, `result` などの曖昧な名前を避け、役割を正確に表す名前を使う

### [SHOULD] 関数の簡潔さ / DRY / KISS
- 1関数1責務に集中させる
- 同じロジックの重複を避ける（DRY）、最もシンプルな解決策を選ぶ（KISS）

### [SHOULD] 不要コードの排除
- `console.log`、コメントアウトされたコード、デッドコードをコミットしない

## エラーハンドリング

### [MUST] 構造化ログ
- エラーは構造化ログ（JSON 形式）で出力すること
- `console.log` を本番ロジックで使わず、ロガー（pino 等の構造化ロガー）を使用する
- 出典: chatwork-slack-bridge-overview.md（推奨インフラ: Cloud Logging）

### [MUST] 外部送信失敗の記録
- Chatwork / Slack への送信失敗は `delivery_attempts` / `outbound_messages.error_message` に記録すること
- 失敗時は Slack に通知する（運用安全性 Phase 3）
- 出典: chatwork-slack-bridge-overview.md（セキュリティ推奨 / Phase 3）

### [SHOULD] 例外メッセージ
- 例外メッセージは英語で記述する
- エラーコンテキスト（操作名、room_id 等の識別子・ただし本文や秘密情報は含めない）を付与する

### [SHOULD] エッジケースの考慮
- 空配列、null/undefined、未参加ルーム・投稿権限なしルーム、Chatwork API レート制限超過などのケースを考慮する
- 出典: chatwork-slack-bridge-overview.md（Chatwork 側の注意点）

### [MAY] カスタムエラークラス
- 署名検証失敗・API 失敗・バリデーション失敗などにドメイン固有のエラークラスを定義する

## ドキュメント

### [MUST] 公開APIのドキュメント
- すべての公開関数・アダプタの公開メソッドに **TSDoc** を記述すること
- `@param`, `@returns`, `@throws` を含める

### [SHOULD] HTTPエンドポイントの文書化
- `/chatwork/webhook`, `/slack/events`, `/slack/interactions`, `/internal/send-chatwork-message` の各エンドポイントについて、入力・処理・前提を文書化する

### [SHOULD] コードコメント
- コメント言語: 日本語
- 「何を」ではなく「なぜ」をコメントする

### [MAY] アーキテクチャ判断記録
- 重要な設計判断（アダプタ境界、queue/secrets の実装選択など）を ADR 形式で記録する

## セキュリティ

### [MUST] Webhook / リクエスト署名検証
- Chatwork Webhook の署名を検証すること
- Slack request の署名を検証すること
- 署名検証に失敗したリクエストは処理せず拒否する
- 出典: chatwork-slack-bridge-overview.md（セキュリティ 必須）

### [MUST] 秘密情報は secret adapter 経由
- `CHATWORK_API_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `DATABASE_URL` などの秘密情報は **secret adapter 経由**で取得すること（ローカル/Docker は `.env`、Google Cloud は Secret Manager）
- 秘密情報をソースコードや workflow に直接書かない
- 出典: chatwork-slack-bridge-overview.md（セキュリティ / CI/CD 公開方針）

### [MUST] ログへの秘密情報・全文出力禁止
- API トークン、Slack bot token、DB 接続文字列をログに出力しないこと
- メッセージ全文・クライアント名を不用意にログや fixture に出力しないこと
- 出典: chatwork-slack-bridge-overview.md（セキュリティ 必須）

### [MUST] 入力バリデーション
- システム境界（Webhook ペイロード、Slack イベント、内部 API）で外部入力を **Zod** でバリデーションすること
- 外部入力には **`safeParse`** を使い、例外に頼らず全 issue をハンドリングする（`parse` は信頼できる内部データのみ）
- `JSON.parse` の結果は信用せず、必ず Zod スキーマで検証してから使う
- 出典: chatwork-slack-bridge-overview.md（技術スタック: Validation = Zod） / skill/zod

### [SHOULD] Zod スキーマの書き方
- `z.any()` を避け **`z.unknown()`** を使う（型安全性を保つ）
- Hono のルート境界では **`@hono/zod-validator`** でバリデーションを宣言的に行う
- ユーザー向けエラーは `error.flatten()` で整形し、カスタムメッセージを付与する
- フォーム/クエリ文字列は `z.coerce` で型変換する
- 出典: skill/zod, skill/hono

### [MUST] SQLインジェクション対策
- 外部入力をそのまま SQL に埋め込まない
- DB アクセスは **Drizzle** のクエリビルダ／パラメータ化クエリを使用する
- 生 SQL を使う場合もプレースホルダでパラメータ化する
- 出典: chatwork-slack-bridge-overview.md（技術スタック: ORM = Drizzle）

### [MUST] 公開エンドポイントの最小化
- 公開エンドポイントは必要最小限にする
- `/internal/*` 系は外部から直接叩けないようにする（キュー実行先としてのみ使用）
- 出典: chatwork-slack-bridge-overview.md（セキュリティ 必須）

### [MUST] 送信前確認の必須化
- Slack から Chatwork への送信は即時投稿せず、必ず送信確認を挟むこと（誤爆防止）
- 出典: chatwork-slack-bridge-overview.md（基本方針 / Slack 側の注意点）

### [SHOULD] 送信操作の allowlist
- Chatwork 送信操作は Slack user allowlist で制限する
- ルームごとに有効/無効を切り替え可能にする（`chatwork_rooms.enabled`）

### [SHOULD] 必要なメッセージだけ保存
- PostgreSQL には後続処理（検索・要約・重複防止）に必要なメッセージだけを保存する

### [SHOULD] HTTPS / Workload Identity
- 公開エンドポイントは HTTPS で提供する
- GCP 認証はサービスアカウント JSON より Workload Identity Federation を優先する

### [MAY] 依存関係の監査
- `npm audit` 等で依存パッケージの脆弱性チェックを定期的に実行する

## データベース（PostgreSQL / Drizzle）

### [MUST] 主キーは identity を使う
- 主キーは **`bigint generated always as identity`** を使う（`serial` / `bigserial` は非推奨）
- グローバルな一意性・不透明性が必要な場合のみ `uuid`（`uuidv7()` または `gen_random_uuid()`）を使う
- 出典: skill/postgresql-table-design

### [MUST] FK カラムに明示的な index を張る
- PostgreSQL は **FK カラムに自動で index を張らない**。参照カラム（`chatwork_room_id`, `outbound_message_id`, `source_message_id` 等）には明示的に index を作成する
- 親テーブルの削除/更新時のロック・JOIN 性能のために必須
- 出典: skill/postgresql-table-design

### [MUST] 複数ステップの DB 操作はトランザクション
- 関連する複数の書き込み（例: `outbound_messages` 挿入 + `delivery_attempts` 記録、メッセージ保存 + Slack ts 更新）は **`db.transaction()`** でまとめ、途中失敗時にロールバックする
- 出典: skill/drizzle-orm-patterns

### [SHOULD] データ型の指針
- 時刻は **`timestamptz`**（`timestamp` 非推奨）、金額は **`numeric`**、文字列は **`text`**（`varchar(n)`/`char(n)` 非推奨。長さ制限は `CHECK (length(col) <= n)`）
- 整数 ID は `bigint`
- 出典: skill/postgresql-table-design

### [SHOULD] status 等の可変ビジネス値は CHECK / lookup
- 進化しうるビジネス値（`status`, `default_reply_mode` 等）は `enum` 型ではなく **`text` + `CHECK` 制約** または lookup テーブルにする（値の追加で型変更を伴わない）
- TypeScript 側は union 型（[SHOULD] 型安全 参照）と対応させる
- 出典: skill/postgresql-table-design

### [SHOULD] UNIQUE と NULL の扱い
- 重複防止の UNIQUE 制約で NULL を 1 つに制限したい場合は **`UNIQUE (...) NULLS NOT DISTINCT`**（PG15+）を使う
- 出典: skill/postgresql-table-design

### [SHOULD] Drizzle の運用
- すべての DB アクセスは Drizzle のクエリビルダ経由（型安全）。スキーマは `src/db/schema.ts`、マイグレーションは **Drizzle Kit** で管理
- 出典: skill/drizzle-orm-patterns, chatwork-slack-bridge-overview.md

## コンテナ / デプロイ（Docker）

### [MUST] イメージにシークレットを焼き込まない
- トークン・接続文字列・鍵をイメージレイヤや `ENV` に埋め込まない。実行時にシークレット管理（`.env` / Secret Manager）から注入する
- 出典: skill/docker, chatwork-slack-bridge-overview.md

### [SHOULD] Dockerfile のベストプラクティス
- **multi-stage build** でビルドと実行を分離し、最終イメージを最小化する
- ベースイメージは **バージョンタグを固定**（`latest` 禁止）、slim/alpine を優先
- **非 root ユーザー** で実行する
- `.dockerignore` で不要ファイル（`node_modules`, `.git`, `.env` 等）を除外する
- 変更頻度の低い命令から順に並べてレイヤキャッシュを効かせる
- 出典: skill/docker

### [SHOULD] 運用設定
- **healthcheck** とリソース制限（CPU / メモリ）を設定する
- docker-compose ではネットワーク・ボリュームを明示し、`depends_on` に healthcheck 条件を付ける（アプリ + PostgreSQL）
- 出典: skill/docker, chatwork-slack-bridge-overview.md

### [SHOULD] CI でのイメージ運用
- CI でイメージをビルドし、**git commit SHA でタグ付け**する
- イメージの脆弱性スキャンを実施する
- 出典: skill/docker

## Git

### [MUST] コミットメッセージ形式
- 形式: **Conventional Commits（英語）**（`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`）
- 例: `feat: add chatwork webhook signature verification`
- 出典: ユーザー指定

### [MUST] ブランチ戦略
- 常にフィーチャーブランチで作業し、`main` に直接コミットしない
- ブランチ命名: `feature/xxx`, `fix/xxx`

### [MUST] 秘密情報・実値のコミット禁止
- 実際の Slack チャンネル ID / Chatwork ルーム ID、クライアント名や本文を含むログ・fixture をコミットしない
- 出典: chatwork-slack-bridge-overview.md（CI/CD 公開方針: 公開しないもの）

### [SHOULD] アトミックコミット
- 各コミットは1つの論理的な変更を表すこと

---

## 共有ユーティリティ・ライブラリ

> 検出されたライブラリ（chatwork-slack-bridge-overview.md の技術スタックより）

| 種別 | ライブラリ | 用途 | ルール |
|------|-----------|------|--------|
| HTTP framework | Hono | Webhook / JSON API | `[SHOULD]` ルーティング・ミドルウェアは Hono の薄い構成で書く |
| ORM | Drizzle | PostgreSQL アクセス | `[SHOULD]` すべての DB アクセスは Drizzle 経由。マイグレーションは Drizzle Kit で管理 |
| Validation | Zod | ランタイムバリデーション | `[SHOULD]` 外部入力のバリデーションは Zod スキーマで行う |
| Slack | @slack/web-api | Slack 投稿・操作 | `[SHOULD]` Slack 操作は slack アダプタ経由でのみ使用 |
| Chatwork | 自前 client | Chatwork API | `[SHOULD]` chatwork アダプタの薄い client 経由でのみ使用 |
| Logging | 構造化ロガー（pino 等） | ログ出力 | `[SHOULD]` `console.log` の代わりに構造化ロガーを使う |

---

## 出典

| ファイル / スキル | 抽出ルール数（概数） |
|---------|-------------|
| chatwork-slack-bridge-overview.md | 約 30 |
| ユーザー指定（対話） | 3（カバレッジ80%、Vitest、Conventional Commits 英語） |
| skill/typescript-best-practices | 型安全（const assertion / discriminated union / branded type / never / z.infer） |
| skill/zod | safeParse / z.unknown / JSON.parse 不信用 / flatten / coerce |
| skill/postgresql-table-design | identity 主キー / FK index / データ型指針 / CHECK / NULLS NOT DISTINCT |
| skill/drizzle-orm-patterns | トランザクション / クエリビルダ / Drizzle Kit |
| skill/docker | シークレット非焼き込み / multi-stage / 非root / healthcheck / SHA タグ |

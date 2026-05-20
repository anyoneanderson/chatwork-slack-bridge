# レビュー基準クイックリファレンス

> coding-rules.md から自動抽出・要約。判断に迷う場合は coding-rules.md を参照。
>
> spec-rules-init により自動生成

## 1. セキュリティ（最優先）

- **[MUST] 署名検証**: Chatwork Webhook / Slack request の署名検証が実装され、失敗時に拒否しているか
- **[MUST] 秘密情報**: `CHATWORK_API_TOKEN` / `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` / `DATABASE_URL` を secret adapter 経由で取得しているか。ハードコードや workflow への直書きがないか
- **[MUST] ログ出力**: トークン・接続文字列・メッセージ全文・クライアント名をログ／fixture に出していないか
- **[MUST] 入力バリデーション**: Webhook・Slack イベント・内部 API の境界で Zod により検証しているか
- **[MUST] SQL インジェクション**: DB アクセスが Drizzle／パラメータ化クエリ経由か。外部入力を生 SQL に直結していないか
- **[MUST] 送信前確認**: Slack → Chatwork 送信が即時投稿でなく確認を挟んでいるか
- **[MUST] 公開エンドポイント最小化**: `/internal/*` が外部から直接叩けない設計か
- **[SHOULD] allowlist / ルーム有効化**: 送信操作の制限・ルーム単位の有効/無効が考慮されているか

## 2. 型安全・データモデル

- **[MUST] strict モード**: TypeScript strict が有効で、型エラーがないか
- **[MUST] 命名規則**: ファイル kebab-case / 変数・関数 camelCase / 型・クラス PascalCase / DB カラム snake_case
- データモデルが overview のスキーマ（unique 制約・index・status 値）と整合しているか
- 重複防止の unique 制約（`chatwork_room_id, chatwork_message_id`）に依存したロジックが正しいか

## 3. フレームワークパターン

- **[MUST] アダプタ境界**: 外部 SDK（Chatwork / Slack / queue / secrets / ai）を `src/adapters/{name}/` に閉じ込めているか。routes/services から直接呼んでいないか
- **[SHOULD] ディレクトリ構成**: `src/adapters` / `src/app`（routes, services）/ `src/db` の構成に従っているか
- **[SHOULD] Hono**: ルーティング・ミドルウェアが薄い構成か
- **[SHOULD] Drizzle**: DB アクセスが Drizzle 経由・マイグレーションが Drizzle Kit 管理か

## 4. コード品質

- **[MUST] Lint / 型チェック**: lint と `tsc --noEmit` がパスするか
- **[SHOULD]** マジックナンバー・ステータス文字列の定数化、曖昧な命名の回避、DRY/KISS、1関数1責務
- **[SHOULD]** `console.log`・コメントアウトコード・デッドコードが残っていないか（構造化ロガー使用）
- **[SHOULD]** import に深い相対パス遡りがないか、未使用 import がないか

## 5. テスト

- **[MUST] カバレッジ 80% 以上**を維持しているか
- **[MUST] Vitest** を使用しているか
- **[MUST] 重要ロジックのテスト**: 署名検証・重複チェック・Chatwork 送信フローにテストがあるか
- **[SHOULD]** 外部 API / DB をアダプタ境界でモックし、ネットワーク非依存か

## 6. レビュー対象外（コメント抑制可）

- `**/*.generated.*`（自動生成ファイル）
- `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`（ロックファイル）
- `dist/**`, `build/**`（ビルド成果物）
- `.specs/**`（仕様書）
- `src/db/migrations/**`（Drizzle 生成マイグレーション）
- `node_modules/**`

## 7. レビュー出力方針

### 共通ルール
- 高影響の指摘を優先し、軽微なスタイル指摘は抑制する
- 既存コード（変更されていない行）への指摘は原則しない
- 根拠（差分、ルール、コマンド出力）がない指摘は断定しない

### 重大度判定
- **重大（セキュリティ・バグ・ドキュメント更新漏れ）**: 必ず対処が必要。修正ループで軽微に降格されない
- **改善提案（品質・可読性）**: 対処を推奨
- **軽微（スタイル等）**: 対処は任意

### 用途別の出力
- **CI レビュー（GitHub Actions）**: インラインは高確信度のみ（QUICK: 最大5件、DEEP: 最大10件）。行特定が曖昧ならまとめコメントへ
- **レビューゲート（spec-implement）**: 重大・改善提案を検出し、修正ループで解消する。投稿ではなく自己修正
- **セカンドオピニオン（cmux-second-opinion）**: 構造化レポートとして親セッションに報告

### レビューモード
- **QUICK**: 高影響のみ
- **DEEP**: 軽微な改善提案も含む

## 8. ドキュメント更新チェック — 重大度: 重大（Critical）

ドキュメント更新漏れは**重大（Critical）**指摘として扱う。修正ループで軽微に降格されず、レビューゲートを通過するにはドキュメントの更新が必須。

新機能追加・既存機能変更時に、関連ドキュメントの更新漏れがないかを確認する。

### Step 1: 主要ドキュメントファイルのチェック

まず、多くのプロジェクトに存在する主要ドキュメントを確認する:

- `README.md` および多言語版（`README.ja.md`, `README.*.md`）
- `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`
- `docs/coding-rules.md`, `docs/review_rules.md`
- `chatwork-slack-bridge-overview.md`（システム概要）
- `docs/deploy/cloud-run.md`, `docs/deploy/docker.md`（デプロイ手順）
- `docs/`, `doc/` ディレクトリ内のファイル

存在する各ファイルについて、コード変更に伴う更新が必要かを判定する。

### Step 2: 追加ドキュメントのスキャン

主要ファイル以外にも、プロジェクトをスキャンして追加のドキュメントを検出する。以下のコマンドは**例示**であり、プロジェクト構造に応じて深度やパターンを調整すること:

```bash
# ドキュメントファイル: Markdown, MDX, reStructuredText, AsciiDoc
find . -maxdepth 6 \( -name "*.md" -o -name "*.mdx" -o -name "*.rst" -o -name "*.adoc" \) \
  -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/vendor/*" \
  -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/.specs/*" 2>/dev/null

# API ドキュメント（OpenAPI, Swagger 等）
find . -maxdepth 6 \( -name "openapi.*" -o -name "swagger.*" -o -name "*.openapi.*" \) \
  -not -path "*/node_modules/*" 2>/dev/null

# ドキュメントディレクトリ
find . -maxdepth 4 -type d \( -name "docs" -o -name "doc" -o -name "documentation" -o -name "wiki" \) \
  -not -path "*/node_modules/*" 2>/dev/null
```

### Step 3: 分類とチェック

検出された各ドキュメントについて、コード変更に伴う更新が必要かを判定する:

| カテゴリ | 更新が必要なケース |
|---------|-----------------|
| プロジェクト README | 新機能追加、インストール手順変更、使用例の陳腐化 |
| システム概要 | アーキテクチャ・データモデル・エンドポイント・技術スタックの変更 |
| コーディング規約 | 新ルール・パターン・ライブラリの導入 |
| デプロイ手順 | 環境変数・Secrets・デプロイ構成の変更 |
| API ドキュメント | エンドポイントの追加・変更・削除 |
| 仕様書 | アーキテクチャや設計判断の変更 |

### Step 4: 報告

変更セットに含まれていないが更新すべきドキュメントファイルを指摘する。特に、データモデル（テーブル定義）・HTTP エンドポイント・必要な環境変数／Secrets を変更した場合は `chatwork-slack-bridge-overview.md` の対応セクションの更新を必須とする。

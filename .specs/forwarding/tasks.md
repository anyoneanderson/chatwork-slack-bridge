# タスクリスト - forwarding（Chatwork 新着メッセージを Slack に転送）

> 入力: `.specs/forwarding/design.md`, `.specs/forwarding/requirement.md`
> 対象 Issue: #3 / 戦略: systematic（品質ゲート重視）/ 粒度: 標準（1タスク = 数時間〜1日）
> ワークフロー: `docs/issue-to-pr-workflow.md`（GitHub Flow / 実装ファースト / cmux マルチエージェント）
> 前提: `.specs/foundation/`・`.specs/cloud-deploy/` 実装済み（config / secret adapter+factory / db client / Hono / `/health`）

## 1. 概要

設計書に基づき、Chatwork webhook 受信 → 保存 → ルーティング → Slack 投稿の一方向フローを 4 フェーズに
分解する。`[code]` フェーズの後には必ず `[orchestrator]` のレビューゲート（spec-review + spec-test）を挟む。
Slack 返信・queue/リトライ・アクションボタン動作・後続テーブルは対象外。

Slack App / Chatwork webhook・API トークンは手動プロビジョニング前提（ASM-003/004）。本タスクは
アプリ・スキーマ・アダプタ側の実装が対象。秘密情報・実 ID・本文を含む fixture はコミットしない（CON-005）。

## 2. タスク一覧

### Phase 1: スキーマ・secret/config 基盤 [code]
- [ ] T001: [REQ-004] `db/schema.ts` に `chatwork_rooms` / `chatwork_messages` を定義（identity PK / timestamptz / room_type・status の CHECK / FK index / unique 制約）
- [ ] T002: [REQ-004] `pnpm db:generate` で migration 生成・`pnpm db:migrate` で適用確認（compose 上）
- [ ] T003: [REQ-009] secret/config 拡張（`SECRET_KEYS` union + `ConfigSchema` に `CHATWORK_WEBHOOK_TOKEN`/`CHATWORK_API_TOKEN`/`SLACK_BOT_TOKEN`/`SLACK_DEFAULT_GROUP_CHANNEL_ID`/`SLACK_DEFAULT_DM_CHANNEL_ID` 追加、`.env.example` 追記、factory の gcp prefetch 拡張）

### Phase 1-R: 基盤 レビューゲート [orchestrator]
- [ ] T003-R: Phase 1 の spec-review + spec-test（スキーマが coding-rules `[MUST]` 準拠 / 既存 secret IF 非破壊 / 秘密非ログ / migration 適用確認）

### Phase 2: chatwork adapter（署名検証 / payload / client）[code]
- [ ] T004: [REQ-002] `adapters/chatwork/verify-signature.ts`（HMAC-SHA256 / base64 / `timingSafeEqual` / 長さ事前チェック）
- [ ] T005: [REQ-003] `adapters/chatwork/webhook-schema.ts`（Zod payload / `message_created` 判定）+ `types.ts`（branded type / `ROOM_TYPES`）
- [ ] T006: [REQ-006] `adapters/chatwork/client.ts`（`getRoom` = `GET /rooms/{id}` 薄い client / `X-ChatWorkToken` / エラー型）
- [ ] T007: [NFR-002] 署名検証ユニットテスト（正当 / 改竄 / ヘッダ欠落 / base64 不正 / 長さ不一致）+ schema テスト

### Phase 2-R: chatwork adapter レビューゲート [orchestrator]
- [ ] T007-R: Phase 2 の spec-review + spec-test（署名検証が raw body 対象 / timing-safe / safeParse / トークン非ログ / 署名テスト網羅）

### Phase 3: slack adapter（整形 / 投稿）[code]
- [ ] T008: [REQ-008] `@slack/web-api` 依存追加 + `adapters/slack/client.ts`（`postMessage` → `{ ts }` / `SlackApiError`）+ `types.ts`
- [ ] T009: [REQ-008] `adapters/slack/format.ts`（ルーム名・送信者・本文の整形。アクションボタンは含めない）+ 整形ユニットテスト

### Phase 3-R: slack adapter レビューゲート [orchestrator]
- [ ] T009-R: Phase 3 の spec-review + spec-test（slack アダプタ境界遵守 / ボタン非表示 / トークン非ログ）

### Phase 4: サービス・ルート結線 [code]
- [ ] T010: [REQ-007] `app/services/resolve-target.ts`（ルーティング判定 / discriminated union / `never` 網羅）+ 全分岐テスト
- [ ] T011: [REQ-005/006/008] `app/services/forward-message.ts`（**ルーム解決(find/getRoom upsert)→ `my` は保存前 skip → `onConflictDoNothing` returning で保存（FK 親確保済み）→ resolveTarget → Slack 投稿 → ts UPDATE / 整合性方針**）+ 重複チェック・FK 順序・my skip テスト
- [ ] T012: [REQ-001] `app/routes/chatwork-webhook.ts`（raw body / 署名検証 / **`JSON.parse` を try/catch で捕捉** / safeParse / イベント判定 / service 呼び出し）+ `routes/index.ts` マウント + ルートテスト（署名失敗 401 / 壊れ JSON 200 / 対象外 200）
- [ ] T013: [REQ-001] `src/index.ts` 起動シーケンス拡張（chatwork/slack client 生成して `createApp` に注入）
- [ ] T013b: [docs] `chatwork-slack-bridge-overview.md` 更新（`chatwork_rooms.slack_channel_id` を nullable 化 + `room_type` 追加 / `POST /chatwork/webhook` 実装反映 / 新 env・Secrets（`CHATWORK_WEBHOOK_TOKEN`/`CHATWORK_API_TOKEN`/`SLACK_BOT_TOKEN`/`SLACK_DEFAULT_*_CHANNEL_ID`）追記 / 表示例からアクションボタン削除）※review_rules で overview 更新漏れは重大扱い

### Phase 4-R: サービス・ルート レビューゲート [orchestrator]
- [ ] T013-R: Phase 4 の spec-review + spec-test（冪等性 / FK 順序・my 保存前 skip / 整合性方針 / アダプタ境界 / 公開エンドポイント最小 / ルーティング網羅 / **overview 更新漏れ確認** / カバレッジ 80%）

### Phase 5: 最終品質ゲート・受け入れ確認・PR [orchestrator]
- [ ] T014: Final Quality Gate（`pnpm lint` / `pnpm typecheck` / `pnpm test` 一括 + 受け入れ基準確認 + **overview 更新の反映確認** + 受け入れ確認（実 Slack API 手動確認 と モック/fake adapter 確認を分離。CON-005））
- [ ] T015: PR 作成（Issue #3 紐付け）

## 2.1 優先度・実装順

| 優先度 | タスク | 理由 |
|--------|--------|------|
| P0（受け入れ基準直結） | T001, T004, T005, T011, T012, T014 | スキーマ・署名検証・保存/重複・ルート・受け入れ確認は Issue #3 の受け入れ基準そのもの |
| P1（品質・機能完成） | T002, T003, T006, T007, T008, T009, T010, T013, T013b + 各 `-R` | migration 適用・config・client・整形・ルーティング・結線・テスト・overview 更新 |
| P2（仕上げ） | T015 | PR 作成（全ゲート通過後） |

> 実装順はフェーズ順（Phase 1 → 5）に従う。Phase 1（スキーマ/config）は他フェーズの前提のため最初に固める。

## 3. タスク詳細

### T001 [REQ-004] スキーマ定義
- **完了条件**: `chatwork_rooms` / `chatwork_messages` を Drizzle で定義。`bigint generated always as identity` PK、
  `timestamptz`、`room_type`・`status` の `text`+`CHECK`、`slack_channel_id` nullable、
  `unique (chatwork_room_id, chatwork_message_id)`、FK + 検索用 index。TS 側 union（`ROOM_TYPES`/`MESSAGE_STATUS`）と対応。
- **対象**: `src/db/schema.ts`
- **依存**: なし

### T002 [REQ-004] migration 生成・適用
- **完了条件**: `pnpm db:generate` で SQL 生成、`pnpm db:migrate` が compose 上の PostgreSQL に適用成功。
- **対象**: `src/db/migrations/`
- **依存**: T001

### T003 [REQ-009] secret / config 拡張
- **完了条件**: 新 5 キーを `SECRET_KEYS` と `ConfigSchema` に追加。`.env.example` にキー名のみ追記。
  gcp backend の factory が新トークンも prefetch する。既存の同期 `get(key)` IF・起動シーケンスを壊さない。
- **対象**: `src/adapters/secrets/types.ts`, `src/config/env.ts`, `src/adapters/secrets/factory.ts`, `.env.example`
- **依存**: なし

### T004 [REQ-002] 署名検証
- **完了条件**: `verifyChatworkSignature(rawBody, signature, token)` を実装。base64 デコード鍵で HMAC-SHA256、
  `timingSafeEqual`、長さ不一致・欠落・base64 不正で false。TSDoc 付き。
- **対象**: `src/adapters/chatwork/verify-signature.ts`
- **依存**: なし

### T005 [REQ-003] payload schema / 型
- **完了条件**: `WebhookPayloadSchema`（Zod）と branded type / `ROOM_TYPES` / `CHATWORK_EVENT_TYPES` 定義。
  `message_created` の `webhook_event` 送信者フィールドは **`account_id`**（`from_account_id` ではない）。
- **対象**: `src/adapters/chatwork/webhook-schema.ts`, `src/adapters/chatwork/types.ts`
- **依存**: なし

### T006 [REQ-006] Chatwork client
- **完了条件**: `getRoom(roomId)` が `GET /rooms/{id}` を `X-ChatWorkToken` で呼び `{ name, type }` を返す。
  失敗時 `ChatworkApiError`（本文・トークン非含有）。
- **対象**: `src/adapters/chatwork/client.ts`
- **依存**: T005

### T007 [NFR-002] chatwork adapter テスト
- **完了条件**: 署名検証（正当/改竄/欠落/base64不正/長さ不一致）、schema `safeParse`（正常/欠落/型不正/対象外イベント）。
- **対象**: `*.test.ts`（chatwork adapter）
- **依存**: T004, T005

### T008 [REQ-008] Slack client
- **完了条件**: `@slack/web-api` 追加、`postMessage(channelId, message)` が `chat.postMessage` を呼び `{ ts }` を返す。
  `SLACK_BOT_TOKEN` で初期化、失敗時 `SlackApiError`。
- **対象**: `package.json`, `src/adapters/slack/client.ts`, `src/adapters/slack/types.ts`
- **依存**: T003

### T009 [REQ-008] Slack 整形
- **完了条件**: `format(message, room)` がルーム名・送信者・本文を整形（**アクションボタンなし**）。整形テスト付き。
- **対象**: `src/adapters/slack/format.ts`, `*.test.ts`
- **依存**: なし

### T010 [REQ-007] ルーティング判定
- **完了条件**: `resolveTarget(room, deps)` が my→skip / disabled→skip / mapped→専用 / group/direct→集約 を返す。
  discriminated union + `never` 網羅。全分岐テスト。
- **対象**: `src/app/services/resolve-target.ts`, `*.test.ts`
- **依存**: T005

### T011 [REQ-005/006/008] forward-message サービス
- **完了条件**: **ルーム解決を先に**（`chatwork_rooms` find → 初見は `getRoom` → upsert）→ `room_type = my` は
  **保存前に skip** → `chatwork_messages` を `onConflictDoNothing` returning で保存（**親ルーム行があり FK 充足**・
  再送は no-op）→ `resolveTarget`（disabled は保存のみ）→ Slack 投稿 → `slack_channel_id`/`slack_ts` UPDATE。
  整合性方針（メッセージ保存先行コミット・Slack はトランザクション外）。
- **getRoom 失敗時**: 初見ルームで `getRoom` 失敗なら保存せず 200 + ログ（FK を満たせないため）。Slack 投稿失敗（保存済み・ts のみ null）とは区別。
- **テスト**: 重複チェック（新規挿入/再送 no-op）、FK 順序（初見ルームで rooms→messages 順）、`my` の保存前 skip、getRoom 失敗で未保存。
- **対象**: `src/app/services/forward-message.ts`, `*.test.ts`
- **依存**: T001, T006, T008, T010

### T012 [REQ-001] webhook ルート
- **完了条件**: raw body 取得 → 署名検証（失敗 401）→ **`JSON.parse` を try/catch で捕捉（壊れ JSON は本文非ログで 200）**
  → `safeParse`（失敗 200）→ `message_created` 判定（対象外 200）→ `forwardMessage` 呼び出し → 200。
  `routes/index.ts` にマウント。ルートテスト（署名失敗 401 / 壊れ JSON 200 / 対象外 200 / 正常経路）。
- **対象**: `src/app/routes/chatwork-webhook.ts`, `src/app/routes/index.ts`, `*.test.ts`
- **依存**: T004, T005, T011

### T013 [REQ-001] 起動シーケンス結線
- **完了条件**: `src/index.ts` で chatwork/slack client を config から生成し `createApp` に注入。`pnpm dev` で起動確認。
- **対象**: `src/index.ts`, `src/app/server.ts`（AppDeps 拡張）
- **依存**: T006, T008, T012

### T013b [docs] overview 更新
- **完了条件**: `chatwork-slack-bridge-overview.md` を本 spec の実装に合わせて更新する:
  - データモデル: `chatwork_rooms.slack_channel_id` を nullable 化、`room_type`（group/direct/my）列を追加。
  - エンドポイント: `POST /chatwork/webhook` の処理（署名検証 / 重複 / 保存 / ルーティング転送）を実装に合わせる。
  - 環境変数 / Secrets: `CHATWORK_WEBHOOK_TOKEN` / `CHATWORK_API_TOKEN` / `SLACK_BOT_TOKEN` /
    `SLACK_DEFAULT_GROUP_CHANNEL_ID` / `SLACK_DEFAULT_DM_CHANNEL_ID` を追記。
  - Slack 表示例: Phase 3 はアクションボタン非表示のため、表示例から `Actions:` 行を削除（または後続フェーズ注記）。
- **理由**: review_rules.md でデータモデル/エンドポイント/環境変数変更時の overview 更新漏れは **重大（Critical）** 扱い。
- **対象**: `chatwork-slack-bridge-overview.md`
- **依存**: T001, T003, T012（実装が固まってから反映）

### T014 最終品質ゲート・受け入れ確認
- **完了条件**: `pnpm lint`/`pnpm typecheck`/`pnpm test`（カバレッジ 80%）が通る。requirement.md の受け入れ基準を全項目確認。
  overview（T013b）が実装と整合していることを確認。受け入れ確認は2系統に分離する:
  - **モック/fake adapter 確認**: ダミー署名 webhook → 保存 → ルーティング（Slack adapter はモック）をローカルで検証。
  - **実 Slack API 手動確認**: ダミーチャンネルへの実投稿（実 ID・本文・クライアント名は fixture/ログに残さない。CON-005）。
- **依存**: T001〜T013b

### T015 PR 作成
- **完了条件**: フィーチャーブランチから PR 作成、Issue #3 を `Closes #3` で紐付け。Conventional Commits。
- **依存**: T014

## 4. 受け入れ基準の対応表（Issue #3）

| 受け入れ基準 | 対応タスク |
|------|-----------|
| 署名検証に失敗した webhook を拒否する | T004, T007, T012 |
| 新着が `chatwork_messages` に保存され重複は弾かれる | T001, T011 |
| Slack 専用/集約チャンネルに投稿され ts 等が保存される | T008, T009, T010, T011 |
| my 無視（保存前 skip）/ disabled 保存のみ / 未紐付け集約の振り分け | T010, T011 |
| 署名検証・重複チェックのテスト（カバレッジ 80%） | T007, T011, T014 |
| `pnpm lint`/`typecheck`/`test` が通る | T014 |
| overview ドキュメントの更新（データモデル/エンドポイント/env） | T013b, T013-R, T014 |

## 5. 並列実行計画

- **Phase 1**: T001 → T002 は直列。T003 は T001/T002 と並列可。
- **Phase 2**: T004 / T005 は並列。T006 は T005 後。T007 は T004/T005 後。
- **Phase 3**: T008（T003 後）/ T009 は並列可。
- **Phase 4**: T010（T005 後）→ T011（T001/T006/T008/T010 後・**ルーム解決→保存の順**）→ T012（T004/T005/T011 後）→ T013 → T013b（実装確定後にドキュメント反映）。
- 各フェーズ末の `-R` ゲートを通過してから次フェーズへ進む（systematic）。

## 6. リスクと留意点

| リスク | 対応 |
|--------|------|
| Chatwork 署名仕様の取り違え（base64 鍵デコード有無等） | 実装時に公式ドキュメントで再確認（ASM-001）。署名テストで実値ベクタを 1 つ固定 |
| Hono で raw body を取得する前に parse して body を失う | ルートで `arrayBuffer()` を先に取得してから検証・parse（CON-001）。テストで担保 |
| 初見ルームで `getRoom` 失敗（権限なし/429/ネットワーク） | 親ルーム行を作れず FK を満たせないため**保存せず 200 + ログ**。取りこぼしは Chatwork 再送に委ね、恒久対策は ops-safety（REQ-006 / design 4.5）。Slack 投稿失敗（保存済み）とは区別 |
| 既知ルームのメタ陳腐化（名前変更等） | 本フェーズはメタ再取得しない（キャッシュ優先）。名前同期は後続フェーズで検討 |
| 実 ID・本文の fixture 混入 | ダミー値のみ使用（CON-005）。レビューゲートで確認 |

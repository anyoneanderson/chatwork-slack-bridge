# タスクリスト - sender-name / Slack 表示改善

> 入力: `.specs/sender-name/design.md`, `.specs/sender-name/requirement.md`
> 対象 Issue: #17 / 戦略: systematic（品質ゲート重視）/ 各 `[code]` フェーズ末に `[orchestrator]` レビューゲート（spec-review + spec-test + セカンドオピニオン）
> 前提: forwarding（#3）本番稼働中。既存フロー非破壊（CON-001）

## 1. 概要

送信者名解決・Chatwork メッセージリンク・メッセージ記法整形の3点を、forwarding の上に**割り込み追加**する。スキーマ → chatwork adapter（取得/整形/リンク）→ サービス・整形・結線 → 最終ゲートの4フェーズ。

## 2. タスク一覧

### Phase 1: スキーマ・migration [code]
- [ ] T001: [REQ-003] `db/schema.ts` に `chatwork_room_members` を定義（identity PK / timestamptz / FK + index / unique(room_id, account_id)）
- [ ] T002: [REQ-003] `pnpm db:generate` で migration 生成・compose 上 PostgreSQL で `pnpm db:migrate` 適用確認

### Phase 1-R: 基盤レビューゲート [orchestrator]
- [ ] T002-R: Phase 1 の spec-review + spec-test（スキーマ `[MUST]` 準拠 / FK index / unique / forwarding スキーマ非破壊）

### Phase 2: chatwork adapter（取得 / 整形 / リンク）[code]
- [ ] T003: [REQ-001] `adapters/chatwork/client.ts` に `getRoomMembers`（`GET /rooms/{id}/members` / `X-ChatWorkToken` / `ChatworkMember[]` / 失敗で `ChatworkApiError`・氏名非含有）
- [ ] T004: [REQ-007] `adapters/chatwork/render-body.ts`（記法整形）+ `adapters/chatwork/chatwork-emoticons.ts`（主要絵文字辞書）。タグ変換（`[download]`→📎 / `[info][title][dtext]` / `[qt]`引用 / `[To][rp][picon][hr]` / 未知タグ原文維持）+ 絵文字置換（未知は原文維持）
- [ ] T005: [REQ-006] `adapters/chatwork/message-link.ts`（`#!rid{room}-{message}` 生成）

### Phase 2-R: chatwork adapter レビューゲート [orchestrator]
- [ ] T005-R: Phase 2 の spec-review + spec-test（getRoomMembers のトークン/氏名非漏洩 / render-body の各タグ・絵文字・未知記法・複合 / link 生成 / アダプタ境界）

### Phase 3: サービス・整形・結線 [code]
- [ ] T006: [REQ-002] `app/services/resolve-sender.ts`（キャッシュ→ミス時1回リフレッシュ→fallback null。getRoomMembers 失敗は null・`forward.sender.unresolved` ログ・例外を投げない）+ メンバー upsert（冪等）
- [ ] T007: [REQ-005/006/007] `adapters/slack/format.ts` 変更（`FormatMessageInput` に `senderName`/`roomId`/`messageId` 追加 / 送信者は表示名優先・account_id フォールバック / `renderChatworkBody` 適用 / `Chatworkで開く` リンク付与 / エスケープ維持・引用 `>` を壊さない）
- [ ] T008: [REQ-002/004] `app/services/forward-message.ts` 結線（保存前に `resolveSenderName` → `sender_name` を INSERT 値に含める → `format` に roomId/messageId/senderName を渡す）。既存フロー（FK 順序 / my skip / 冪等 / 整合性）非破壊
- [ ] T009: [docs] `chatwork-slack-bridge-overview.md` 更新（`sender_name` 解決・`chatwork_room_members`・Slack 表示例（表示名 / リンク / 絵文字・添付整形））

### Phase 3-R: サービス・整形レビューゲート [orchestrator]
- [ ] T009-R: Phase 3 の spec-review + spec-test（名前解決の3経路 / sender_name 保存 / format 表示名・リンク・整形・エスケープ / forward-message 非破壊 / overview 更新漏れ確認 / カバレッジ 80%）

### Phase 4: 最終品質ゲート・受け入れ確認・PR [orchestrator]
- [ ] T010: Final Quality Gate（`pnpm lint`/`typecheck`/`test`（カバレッジ80%）+ 受け入れ基準確認 + overview 反映確認 + モック/fake adapter での表示確認。実 Slack 手動確認は運用者ステップに分離・CON-002）
- [ ] T011: PR 作成（Issue #17 を `Closes #17` で紐付け）

## 3. タスク詳細（要点）

### T001 [REQ-003] chatwork_room_members
- **完了条件**: design §3.1 のスキーマを Drizzle で定義。`bigint identity` PK / `timestamptz` / FK `chatwork_room_id`→`chatwork_rooms` + 明示 index / `unique(chatwork_room_id, chatwork_account_id)`。
- **対象**: `src/db/schema.ts`

### T003 [REQ-001] getRoomMembers
- **完了条件**: `getRoom` と同形。`ChatworkMember[]`（`accountId` 文字列化 / `name`）。非2xx・ネットワーク・不正レスポンスで `ChatworkApiError`（status のみ）。トークン・氏名をエラー/ログに含めない。
- **対象**: `src/adapters/chatwork/client.ts`, `types.ts`

### T004 [REQ-007] render-body
- **完了条件**: design §4.3 のタグ変換＋絵文字辞書置換。純粋関数・I/O 無し。未知タグ/未知絵文字は原文維持。`[download:id]inner[/download]`→`📎 inner`。
- **対象**: `src/adapters/chatwork/render-body.ts`, `src/adapters/chatwork/chatwork-emoticons.ts`

### T006 [REQ-002] resolve-sender
- **完了条件**: cache→refresh(1回)→fallback。`getRoomMembers` 失敗時 null・転送継続・`forward.sender.unresolved` ログ（識別子のみ）。メンバー upsert は冪等（onConflictDoUpdate）。
- **対象**: `src/app/services/resolve-sender.ts`
- **依存**: T001, T003

### T007 [REQ-005/006/007] format
- **完了条件**: 送信者＝`senderName ?? accountId ?? unknown`。本文＝`renderChatworkBody` 適用後にエスケープ。末尾に `<url|Chatworkで開く>`。引用 `>` が `&gt;` で壊れないこと（テストで担保）。
- **対象**: `src/adapters/slack/format.ts`
- **依存**: T004, T005

### T008 [REQ-002/004] forward-message 結線
- **完了条件**: ルーム解決後・保存前に `resolveSenderName` 呼び出し → `chatwork_messages.sender_name` に格納 → `format` に `senderName`/`roomId`/`messageId` を渡す。既存の FK 順序・my skip・`onConflictDoNothing`・整合性方針・getRoom/Slack/ts 失敗ハンドリングを壊さない。
- **対象**: `src/app/services/forward-message.ts`
- **依存**: T006, T007

## 4. 受け入れ基準の対応（Issue #17）

| 受け入れ基準 | 対応タスク |
|------|-----------|
| 送信者を表示名で表示（fallback account_id） | T006, T007, T008 |
| account_id→表示名をキャッシュ・毎回APIを叩かない | T001, T003, T006 |
| sender_name 保存 | T008 |
| Chatwork メッセージリンク | T005, T007 |
| 絵文字・タグ・添付の整形（生タグ残さない） | T004, T007 |
| トークン非ログ | T003, T006 |
| テスト（カバレッジ80%） | 各 `-R`, T010 |
| lint/typecheck/test 通過 | T010 |
| overview 更新 | T009, T009-R, T010 |

## 5. リスクと留意点

| リスク | 対応 |
|--------|------|
| 引用 `>` が Slack 整形で壊れる | render→escape 順を固定し、引用行頭 `>` をエスケープ対象外に。テストで担保 |
| 記法の網羅漏れ | 未知タグ/絵文字は原文維持（壊さない）。主要セットのみ対応、拡充は後続 |
| メンバー API レート制限 | ミス時1回のみリフレッシュ + DB キャッシュ。失敗は account_id フォールバック |
| forwarding 非破壊 | 既存テストを維持し、結線は割り込みのみ。Phase 3-R で重点確認 |
| 実名・実ファイル名の混入 | fixture はダミー（CON-002）。レビューゲートで確認 |

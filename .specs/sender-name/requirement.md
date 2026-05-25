# 要件定義書 - sender-name / Slack 表示改善（送信者名・リンク・記法整形）

> 対象 Issue: [#17 \[Enhancement\] sender-name — Chatwork 送信者名の解決](https://github.com/anyoneanderson/chatwork-slack-bridge/issues/17)
> 参照: `.specs/forwarding/`（実装・本番稼働済み）, `chatwork-slack-bridge-overview.md`, `docs/coding-rules.md`, `docs/review_rules.md`
> 前提: `#3 forwarding` 実装済み（`chatwork_rooms` / `chatwork_messages` / chatwork client / slack format / forward-message）

## 1. 概要

forwarding（#3）で Slack に転送されるメッセージの表示を、人間が読める形に改善する。実環境で次の3つの表示問題が確認された:

1. **送信者が account_id（数字）のまま**（例 `2010319:`）。webhook payload に送信者名が無く、Phase 3 では account_id 表示としていた（forwarding ASM-002 / REQ-005 で「名前解決は後続フェーズ」と明記）。
2. **Chatwork メッセージへの導線が無い**。Slack だけ見て Chatwork 原本を開けない。
3. **Chatwork 独自のメッセージ記法が生のまま出る**。絵文字ショートコード `(blush)` や特殊タグ `[info][title]…[download:id]…[/download][/info]` がそのまま表示され、可読性が低い。

本 Issue でこの3点を解消する。本文・送信者・ルーム名のエスケープ（Slack 通知インジェクション対策）は forwarding の現行挙動を維持する。

### スコープ外（本 Issue では作らない）

- Chatwork 添付ファイルの Slack 再アップロード（`files.upload`）→ 別 Issue（後続）。本 Issue は**ファイル名・サイズの整形表示のみ**。
- ルーム名・種別の再解決（forwarding の getRoom キャッシュ優先のまま）。
- メンバー情報の継続同期（退会・改名追従）。キャッシュ優先＋ミス時リフレッシュのみ。
- 絵文字マップの全網羅（主要セットを用意し、未知は原文維持。拡充は後続）。
- マルチトークン Webhook 管理 / 管理 CLI（別 Issue）。
- Slack → Chatwork 返信（#4 slack-reply）。

## 2. 機能要件

### [REQ-001] Chatwork メンバー取得 API（`getRoomMembers`）
- chatwork adapter の薄い client に `getRoomMembers(roomId)` を追加し、`GET /rooms/{room_id}/members` を `X-ChatWorkToken` で呼ぶ。
- レスポンス配列から `account_id`（→ 文字列化）と `name` のペアを取り出して返す。
- 失敗時（認可・レート制限・ネットワーク・不正レスポンス）は `ChatworkApiError`（既存）を throw。トークン・本文・氏名をエラー/ログに含めない。
- ユーザーストーリー: 開発者として、account_id から表示名を引くための一覧を取得したい。

### [REQ-002] 送信者名の解決（キャッシュ → リフレッシュ → フォールバック）
- メッセージ転送時、送信者 `account_id` の表示名を解決する。
  1. `chatwork_room_members` キャッシュを `(room_id, account_id)` で参照。
  2. ヒットしなければ `getRoomMembers(room_id)` で取得し、メンバーをキャッシュへ upsert してから再参照（**1メッセージあたりリフレッシュは最大1回**）。
  3. それでも見つからない、または `getRoomMembers` が失敗した場合は **`account_id` にフォールバック**し、転送は止めない（forwarding の getRoom 失敗方針 design §4.5 と整合）。
- ユーザーストーリー: 利用者として、Slack で「誰が送ったか」を名前で把握したい。

### [REQ-003] メンバーキャッシュ（`chatwork_room_members` テーブル追加）
- 新テーブル `chatwork_room_members` を追加（migration）。`(chatwork_room_id, chatwork_account_id)` を unique、`chatwork_room_id` に FK + index。`name` を保持。
- 既存の `chatwork_rooms` の DB キャッシュ方針と統一（Cloud Run のマルチインスタンス/再起動でも共有・永続）。
- ユーザーストーリー: 運用者として、毎回メンバー API を叩かず（レート制限回避）名前解決したい。

### [REQ-004] 送信者名の永続化
- 解決できた表示名を `chatwork_messages.sender_name`（既存・現状 null）に保存する。解決できなければ null のまま。

### [REQ-005] Slack 表示の送信者名化
- `adapters/slack/format.ts` を変更し、送信者を **表示名**で出す。解決できない場合は従来どおり `account_id` を表示（`unknown` は最終フォールバック）。

### [REQ-006] Chatwork メッセージへのディープリンク
- Slack 投稿に Chatwork メッセージへのリンクを含める。形式 `https://www.chatwork.com/#!rid{room_id}-{message_id}`（Chatwork の特定メッセージリンク仕様 / ASM-003）。
- リンクは Slack mrkdwn 形式（`<URL|Chatworkで開く>`）。URL はブリッジが構築する信頼値のためエスケープ対象外（room_id / message_id は秘密ではない）。

### [REQ-007] Chatwork メッセージ記法の Slack 向け整形
- 本文を Slack に載せる前に **Chatwork記法 → 可読テキスト**へ変換する変換器を通す:
  - **絵文字ショートコード**: 主要な Chatwork 顔文字（`(blush)` `(gogo)` `(beer)` 等）を Unicode 絵文字（または Slack `:shortcode:`）にマップ。未知のショートコードは原文維持。
  - **特殊タグの変換/除去**:
    - `[info]…[/info]` / `[title]…[/title]` → 枠を外し、見出し＋本文の素テキストに。
    - `[dtext:key]` → 既知のシステム文言（例 `file_uploaded` → 「ファイルをアップロードしました」）。未知キーは無難な文言 or 除去。
    - `[download:fileId]ファイル名 (サイズ)[/download]` / `[preview id=… ht=…]` → **`📎 ファイル名 (サイズ)`** に整形（実体は (A) 表示のみ。ダウンロードはしない）。
    - `[To:aid]` / `[rp aid=… to=…]`（メンション/返信）→ 除去 or `@` 表記。
    - `[qt][qtmeta …]…[/qt]`（引用）→ Slack 引用（`> `）。
    - `[picon:aid]` `[piconname:aid]` → 除去。`[hr]` → 区切り（`---`）。
- 変換後のテキストにも Slack 制御シーケンスのエスケープ（`&` `<` `>`）を維持する（記法変換で生成した自前のリンク・記号は除く）。
- ユーザーストーリー: 利用者として、絵文字や添付・装飾を含むメッセージも Slack で破綻なく読みたい。

## 3. 非機能要件

### [NFR-001] アダプタ境界
- Chatwork メンバー API は `src/adapters/chatwork/` に閉じる。記法整形ロジックの置き場所は設計で決める（chatwork 由来データの変換のため chatwork adapter 寄り）。Slack SDK は `src/adapters/slack/` のまま。

### [NFR-002] 秘密・本文の非ログ
- `*_TOKEN` は secret adapter 経由。トークン・本文・氏名はログに出さない（forwarding NFR-003 を踏襲。ログは op・識別子のみ）。

### [NFR-003] テスト（coding-rules `[MUST]` / カバレッジ 80%）
- 必須テスト: 名前解決（キャッシュヒット / ミス時リフレッシュ / 失敗フォールバック）、記法整形（絵文字・各タグ・添付・未知記法）、ディープリンク生成、Slack 整形。
- Chatwork API / DB はアダプタ境界でモックし、外部ネットワーク非依存。

### [NFR-004] 冪等性・非破壊
- メンバーキャッシュ upsert は冪等（再受信で重複しない）。forwarding の冪等保存・FK 順序・my skip・整合性方針を壊さない。

## 4. 制約事項

### [CON-001] forwarding 非破壊
- 既存の `forward-message` のフロー（ルーム解決→my skip→`onConflictDoNothing` 保存→resolveTarget→Slack 投稿→ts UPDATE）と本番挙動を壊さない。名前解決・整形は既存フローに割り込む形で追加する。

### [CON-002] OSS / 秘密情報・実値
- 実 account_id・実名・実ファイル名・本文・実 room/channel ID を fixture・ログに残さない。テストはダミー値（CON-005 踏襲）。

### [CON-003] Git / ブランチ
- フィーチャーブランチで作業。Conventional Commits（英語）。

## 5. 前提条件

### [ASM-001] メンバー API のレスポンス
- `GET /rooms/{room_id}/members` は `account_id`（数値）/ `name` / `role` 等を含む配列を返す。`account_id` は文字列化して扱う。

### [ASM-002] メンバー API 利用前提
- `CHATWORK_API_TOKEN` のアカウントが対象ルームに参加していること（getRoom と同じ前提）。失敗時は account_id フォールバック。

### [ASM-003] Chatwork メッセージリンク仕様
- 特定メッセージへのリンクは `https://www.chatwork.com/#!rid{room_id}-{message_id}`。実装時に最新仕様を確認する。

### [ASM-004] Chatwork メッセージ記法
- 本文は Chatwork 独自記法（絵文字ショートコード・`[tag]` 群）を含みうる。記法は実装時に公式ドキュメント等で確認し、対応セットを確定する。添付ファイルのダウンロードは認証必須のため本 Issue ではリンク化しない。

## 6. 受け入れ基準（Issue #17 準拠）

- [ ] 新着メッセージの Slack 表示に送信者の**表示名**が出る（解決不可なら account_id フォールバック）
- [ ] `account_id → 表示名` をメンバー API から取得し `chatwork_room_members` にキャッシュ、毎回は API を叩かない
- [ ] 解決名が `chatwork_messages.sender_name` に保存される
- [ ] Slack 投稿に **Chatwork メッセージへのリンク**が含まれる
- [ ] 絵文字ショートコード・特殊タグ・添付（ファイル名+サイズ表示）が **可読な形に整形**される（生タグが残らない）
- [ ] メンバー API トークンは secret adapter 経由・ログ非出力
- [ ] 名前解決・記法整形・リンク生成・整形にテストがある（カバレッジ 80%）
- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm test` が通る
- [ ] `chatwork-slack-bridge-overview.md` が更新される（sender_name / メンバーキャッシュ / 表示例）

## 7. 用語集

| 用語 | 定義 |
|------|------|
| 送信者名解決 | `account_id` を Chatwork メンバー API の `name` に対応づける処理 |
| メッセージ記法 | Chatwork 独自の本文記法（絵文字ショートコード・`[info]` `[download]` 等のタグ） |
| ディープリンク | Chatwork の特定メッセージを開く URL（`#!rid{room}-{message}`） |
| メンバーキャッシュ | `chatwork_room_members` に保持する account_id→name の対応 |

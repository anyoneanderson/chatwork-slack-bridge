# 要件定義書 - forwarding（Chatwork 新着メッセージを Slack に転送）

> 対象 Issue: [#3 \[Phase 3\] forwarding — Chatwork 新着メッセージを Slack に転送](https://github.com/anyoneanderson/chatwork-slack-bridge/issues/3)
> 参照: `chatwork-slack-bridge-overview.md`（ユースケース1 / データモデル / `POST /chatwork/webhook`）, `docs/coding-rules.md`, `docs/review_rules.md`
> 前提: `.specs/foundation/`（器）, `.specs/cloud-deploy/`（本番デプロイ）実装済み

## 1. 概要

最初の業務機能。Chatwork Webhook を受けて新着メッセージを PostgreSQL に保存し、Slack の
専用チャンネルへ転送する **一方向フロー**（overview ユースケース1）を実装する。

本フェーズのゴールは、**署名検証を通った Chatwork webhook を受信 → 重複なく DB 保存 → ルーム
種別に応じて適切な Slack チャンネルへ投稿 → Slack の `ts` 等を保存** までを、アダプタ境界を守り
テスト付きで動かすこと。Slack からの返信・queue/リトライ・アクションボタンの動作は含めない。

### 1.1 転送ルーティング（本フェーズの設計の核）

Chatwork のルームには 3 種別（`group` / `direct`（DM） / `my`（マイチャット））があり、
すべて `room_id` で識別される。Webhook payload にはルーム名・種別が含まれないため、初見の
`room_id` は Chatwork API（`GET /rooms/{room_id}`）で名前・種別を取得して `chatwork_rooms`
にキャッシュする。転送先は以下のマトリックスで決定する。

| 条件 | DB 保存 | Slack 投稿先 |
|------|:------:|------------|
| `room_type = my` | ✕ | ✕（転送対象外・無視） |
| `enabled = false`（明示的に無効化） | ○ | ✕（保存のみ） |
| `enabled = true` ＋ `slack_channel_id` あり（紐付け済み） | ○ | その専用チャンネル |
| `enabled = true` ＋ 紐付けなし ＋ `room_type = group` | ○ | `SLACK_DEFAULT_GROUP_CHANNEL_ID`（種別集約） |
| `enabled = true` ＋ 紐付けなし ＋ `room_type = direct` | ○ | `SLACK_DEFAULT_DM_CHANNEL_ID`（種別集約） |

- 初見ルームは `enabled = true` / `slack_channel_id = null` で自動登録し、種別集約チャンネルへ
  フォールバックする。運用者が後から `slack_channel_id` を設定すると専用チャンネルへ切り替わる。
- 不要なルームは `enabled = false` にすると、履歴は DB に残しつつ Slack 投稿を止められる。

### スコープ外（本 Issue では作らない）

- Slack からの返信（送信確認 → Chatwork API 投稿）→ `slack-reply`
- DB-backed queue / リトライ / レート制限対策 → `ops-safety`
- Slack アクションボタンの **動作**（本フェーズは表示もしない。本文＋メタのみ）
- `outbound_messages` / `delivery_attempts` / `ai_drafts` 等のテーブル（後続フェーズ）
- Chatwork メッセージの更新・削除イベント同期（`message_updated` / `message_deleted`）
- allowlist / 対応済みステータス操作（ops-safety）

## 2. 機能要件

### [REQ-001] Chatwork Webhook 受信エンドポイント
- `POST /chatwork/webhook`（Hono）を提供する。
- **署名検証のため raw リクエストボディ（バイト列）を取得**してから検証・パースする。
- 署名検証・パースの成否にかかわらず、受信できたものは原則 `200` を返す（webhook の再送ストーム
  を避ける）。ただし署名検証失敗は `401`（または `403`）で拒否する（[REQ-002]）。
- 公開エンドポイントの追加であり、認可は **署名検証で担保**する（CON-002）。
- ユーザーストーリー: 運用者として、Chatwork に登録した webhook URL が新着メッセージを確実に受け取れること。

### [REQ-002] Chatwork Webhook 署名検証
- `X-ChatWorkWebhookSignature` ヘッダを検証する。署名は
  **Base64( HMAC-SHA256( raw_body, base64decode(WEBHOOK_TOKEN) ) )**。
- 検証は **raw body（パース前のバイト列）** に対して行う。
- 比較は **timing-safe**（`crypto.timingSafeEqual`）で行い、長さ不一致も安全に弾く。
- 署名ヘッダ欠落・不一致のリクエストは処理せず拒否する（`401`/`403`）。
- `WEBHOOK_TOKEN` は secret adapter 経由で取得する（ソース・ログに出さない）。
- ユーザーストーリー: 運用者として、第三者からの偽 webhook を確実に拒否したい。

### [REQ-003] Webhook ペイロードのバリデーションとイベント判定
- ボディを **Zod `safeParse`** で検証する（`JSON.parse` 結果を信用しない）。
- `webhook_event_type` が `message_created` の場合のみ処理する。それ以外（`message_updated`/
  `message_deleted` 等）は no-op で `200` を返す（本フェーズ対象外）。
- `webhook_event` から `room_id` / `message_id` / `account_id`（送信者）/ `body` / `send_time` を取り出す。
  （`message_created` の送信者 ID は **`account_id`**。`from_account_id` は `mention_to_me` 系イベントの
  フィールドであり混同しない。出典: Chatwork webhook docs）
- 署名検証後でも本文が壊れた JSON の可能性があるため、`JSON.parse` も検証境界として捕捉する
  （捕捉漏れによる `500` を防ぎ、検証失敗は `200`/`400` に統一する）。
- バリデーション失敗時は構造化ログ（本文・トークンを含めない）を出し `200`（または `400`）で返す。
- ユーザーストーリー: 開発者として、想定外ペイロードでサーバが落ちたり不正データを保存したりしないこと。

### [REQ-004] 業務テーブルの migration 追加（`chatwork_rooms` / `chatwork_messages`）
- foundation で空だった `src/db/schema.ts` に **本フェーズで使う 2 テーブル**を追加し、Drizzle Kit で
  migration を生成する。
- `chatwork_rooms`: `chatwork_room_id`（unique）, `room_name`, `room_type`（`group`/`direct`/`my`、
  `text` + `CHECK`）, `slack_channel_id`（**nullable**）, `enabled`, タイムスタンプ。
- `chatwork_messages`: overview のデータモデルに準拠。`unique (chatwork_room_id, chatwork_message_id)`
  で重複防止、`raw_payload jsonb`、FK・検索用 index を持つ。
- 主キーは `bigint generated always as identity`、時刻は `timestamptz`、FK カラムに明示 index（coding-rules `[MUST]`）。
- ユーザーストーリー: 開発者として、受信メッセージとルーム紐付けを型安全に永続化したい。

### [REQ-005] 受信メッセージの保存と重複チェック
- `chatwork_messages` に `room_id` / `message_id` / 送信者 `account_id`（→ `chatwork_account_id`）/
  本文 / 送信時刻 / `raw_payload` を保存する。
- **送信者名（`sender_name`）は webhook payload に含まれない**ため、Phase 3 では `account_id` のみを
  確実に保存し、`sender_name` は **nullable**（取得できなければ null）とする。表示は account_id ベースで
  よく、メンバー API 等での名前解決は後続フェーズに回す。
- **保存は「ルーム解決後」に行う**（[REQ-006] / 設計 4.5）。`chatwork_messages.chatwork_room_id` は
  `chatwork_rooms` への FK のため、初見ルームは先に `chatwork_rooms` 行を作ってから挿入する。
- 重複は **`unique (chatwork_room_id, chatwork_message_id)` ＋ `onConflictDoNothing`** で弾く。
  既に存在する `message_id`（webhook 再送）では二重保存・二重 Slack 投稿をしない（冪等）。
- 保存できた（新規挿入された）場合のみ後続の Slack 投稿に進む。
- ユーザーストーリー: 運用者として、Chatwork の webhook 再送で同じメッセージが二重に Slack に流れないこと。

### [REQ-006] ルームメタ（名前・種別）の取得とキャッシュ
- 初見の `chatwork_room_id` は Chatwork API `GET /rooms/{room_id}` で `name` / `type` を取得し、
  `chatwork_rooms` に `enabled = true` / `slack_channel_id = null` で登録する。
- **ルーム解決（検索 or 取得 + 登録）はメッセージ保存より前に行う**。これにより (1) `chatwork_messages`
  の FK 親行を確保し、(2) `room_type = my` を**保存前に判定して弾く**（CON-003）。`my` ルームのメタ行
  自体はキャッシュしてよい（再受信時に `getRoom` を呼ばず即 skip するため）。
- 既知ルームは DB のキャッシュを使い、毎回 API を叩かない（メタの再取得はしないため、既知ルームでは
  `getRoom` 失敗の影響を受けない）。
- Chatwork API 呼び出しは **chatwork adapter の薄い client 経由**でのみ行う（`API_TOKEN` は secret adapter 経由）。
- **初見ルームで `getRoom` が失敗（権限なし・レート制限・ネットワーク）した場合**: 親 `chatwork_rooms`
  行を作れず `chatwork_messages` の FK を満たせないため、**メッセージは保存せず**、構造化ログ（識別子のみ・
  本文/トークン非出力）を残して `200` を返す。取りこぼしは **Chatwork の webhook 再送**に委ね、恒久的な
  再試行（dead-letter / queue）は ops-safety フェーズで扱う。
- 上記の「保存できない」ケースと、**Slack 投稿失敗（メッセージは保存済み・`slack_ts` のみ null）で保存を
  維持する**ケース（NFR-005）は区別する。
- ユーザーストーリー: 運用者として、Slack 上でどのルーム（クライアント/案件）からの発言か分かるようにしたい。

### [REQ-007] 転送ルーティング
- 「1.1 転送ルーティング」のマトリックスに従って投稿先を決定する。
- `room_type = my` は保存も投稿もしない。`enabled = false` は保存のみ。
- 紐付け済み（`slack_channel_id` あり）は専用チャンネル、未紐付けは種別集約チャンネルへ。
- ルーティング判定は名前付き定数・union 型・`never` 網羅性チェックで分岐漏れを防ぐ（coding-rules `[SHOULD]`）。
- ユーザーストーリー: 運用者として、案件ごとに専用チャンネルへ、未設定はまとめチャンネルへ自動で振り分けたい。

### [REQ-008] Slack への投稿と `ts` の保存
- slack adapter（`@slack/web-api`）で対象チャンネルに投稿する（本文＋メタ。ルーム名・送信者・
  Chatwork で開くための情報を整形）。**アクションボタンは表示しない**。
- 投稿成功後、`chatwork_messages` に `slack_channel_id` / `slack_ts`（/ `slack_thread_ts`）を保存する。
  本フェーズの転送は **トップレベル投稿**で、`slack_thread_ts` は null（スレッド化は slack-reply 以降）。
- 投稿失敗時はメッセージ保存を保持し、構造化ログにエラーを記録する（リトライは ops-safety）。
- `SLACK_BOT_TOKEN` は secret adapter 経由で取得する。
- ユーザーストーリー: 利用者として、Chatwork を開かずに Slack で新着内容を読めること。

### [REQ-009] secret / config の拡張
- 以下を `SecretProvider` の `SECRET_KEYS`（union）と `ConfigSchema`（Zod）に追加する:
  - `CHATWORK_WEBHOOK_TOKEN`（署名検証用）
  - `CHATWORK_API_TOKEN`（`GET /rooms` 用）
  - `SLACK_BOT_TOKEN`（Slack 投稿用）
  - `SLACK_DEFAULT_GROUP_CHANNEL_ID`（group 種別集約フォールバック）
  - `SLACK_DEFAULT_DM_CHANNEL_ID`（direct 種別集約フォールバック）
- gcp backend（Secret Manager）では上記秘密情報を prefetch できるよう secret factory を拡張する。
  既存の同期 `SecretProvider` インターフェース（`get(key)`）と起動シーケンスは壊さない。
- `.env.example` にキー名のみ追記する（実値は入れない）。
- ユーザーストーリー: 運用者として、トークン・チャンネル ID を env / Secret Manager から安全に注入したい。

## 3. 非機能要件

### [NFR-001] セキュリティ
- Chatwork Webhook 署名を検証し、失敗したリクエストは処理せず拒否する（`[MUST]`）。
- 秘密情報（`*_TOKEN`）は secret adapter 経由で取得し、ソース・workflow・イメージ・ログに出さない。
- 公開エンドポイントは `/health` と `/chatwork/webhook` のみに留める（最小化）。
- 外部入力（webhook ペイロード）は Zod `safeParse` で検証してから使う。SQL は Drizzle のパラメータ化クエリ。

### [NFR-002] テスト（coding-rules `[MUST]` 反映 / カバレッジ 80%）
- **必ずテストを書く対象**:
  - Chatwork Webhook 署名検証（正当・改竄・ヘッダ欠落・base64 不正・timing-safe）。
  - メッセージ重複チェック（新規挿入 / 再送で no-op の冪等性）。
- 加えて、ルーティング判定（種別別 × 紐付け有無 × enabled）、ペイロード Zod 検証、Slack 整形を
  ユニットテストする。
- Chatwork API / Slack API / DB はアダプタ境界でモックし、外部ネットワーク非依存にする。

### [NFR-003] 構造化ログ
- pino 構造化ログのみ（`console.*` 禁止）。ログ対象は操作名・識別子（`room_id` / `message_id` /
  `slack_channel_id` / `slack_ts`）に限定し、**本文・送信者氏名・トークンは出さない**。

### [NFR-004] アダプタ境界
- Chatwork API / Webhook（署名検証・payload・client）は `src/adapters/chatwork/`、Slack 操作は
  `src/adapters/slack/` に閉じ込める。`routes`/`services` から外部 SDK を直接呼ばない。

### [NFR-005] エラーハンドリングと整合性
- 「メッセージ保存」と「Slack 投稿後の `ts` 更新」は外部呼び出しを挟む 2 段。**メッセージ保存を
  先にコミット**し、Slack 投稿失敗でもメッセージは失わない方針とする（理由を設計に明記）。
- Slack 投稿失敗・API 失敗は構造化ログに記録する。リトライ・queue は本フェーズ対象外（ops-safety）。

### [NFR-006] 冪等性
- 同一 `message_id` の webhook 再送に対し、二重保存・二重 Slack 投稿をしない。

## 4. 制約事項

### [CON-001] 署名検証は raw body に対して
- 署名検証は **パース前の raw body バイト列**で行う。Hono で raw body を取得してから検証・`safeParse` する。

### [CON-002] 公開エンドポイント追加時の認可必須
- 新規公開エンドポイント（`/chatwork/webhook`）は **署名検証/認可を入れずに公開しない**
  （handover stop condition / overview セキュリティ必須）。

### [CON-003] マイチャット（`my`）は対象外
- `room_type = my` のルームは保存も Slack 投稿もしない。

### [CON-004] overview スキーマからの逸脱の明示
- overview の `chatwork_rooms` は `slack_channel_id not null` だが、本フェーズは種別集約フォールバックの
  ため **`slack_channel_id` を nullable** にし、`room_type` 列を追加する。逸脱理由を設計に記録する。

### [CON-005] OSS / 秘密情報・実値
- 実 Slack チャンネル ID / Chatwork ルーム ID、クライアント名・本文を含む fixture・ログをコミットしない。
  テスト fixture はダミー値で構成する。`.env` はコミットせず `.env.example` のみ。

### [CON-006] 既存基盤の非破壊
- 既存の同期 `SecretProvider`（`get(key)`）、`loadConfig`、起動シーケンス、gcp prefetch を壊さない。
  キー追加は `SECRET_KEYS` union への追記と factory の secretNames 拡張で行う。

### [CON-007] Git / ブランチ
- フィーチャーブランチで作業し `main` へ直接コミットしない。コミットは Conventional Commits（英語）。

## 5. 前提条件

### [ASM-001] Chatwork Webhook 署名仕様
- 署名は `X-ChatWorkWebhookSignature` ヘッダに Base64( HMAC-SHA256( body, base64decode(token) ) ) で入る。
  token は Chatwork の webhook 設定で発行される値。実装時に最新仕様を確認する。

### [ASM-002] Webhook payload にルーム名・種別・送信者名は含まれない
- `message_created` の `webhook_event` は `room_id` / `message_id` / `account_id`（送信者）/ `body` /
  `send_time` / `update_time` のみ。**ルーム名・種別・送信者名は含まれない**ため、ルーム名/種別は
  `GET /rooms/{room_id}` で補完し、送信者名は Phase 3 では解決しない（account_id 表示で可）。

### [ASM-003] Chatwork API 利用前提
- `CHATWORK_API_TOKEN` を持つアカウントが対象ルームに参加している（参加していないルームは取得不可）。
  API レート制限を考慮する。

### [ASM-004] Slack App / Bot 前提
- Slack App が作成済みで、`SLACK_BOT_TOKEN`（`chat:write` スコープ）を持ち、Bot が対象チャンネルに
  参加している。集約チャンネル（group/DM フォールバック）も事前に用意・招待済み。

### [ASM-005] queue/リトライは後続
- 本フェーズは同期処理（webhook 内で保存・投稿）でよい。非同期化・リトライは ops-safety で導入する。

## 6. 受け入れ基準（Issue #3 準拠）

- [ ] 署名検証に失敗した webhook を拒否する（正当な署名のみ処理する）
- [ ] 新着メッセージ（`message_created`）が `chatwork_messages` に保存され、重複（再送）は弾かれる
- [ ] ルーティングマトリックスに従い Slack の適切なチャンネルに投稿され、`slack_channel_id` / `slack_ts` が保存される
- [ ] `room_type = my` は無視、`enabled = false` は保存のみ、未紐付けは種別集約チャンネルへ振り分けられる
- [ ] 署名検証・重複チェックにテストがある（coding-rules の重要ロジック必須テスト / カバレッジ 80%）
- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm test` が通る

## 7. 用語集

| 用語 | 定義 |
|------|------|
| ルーム（room） | Chatwork の会話の場。`group`（グループ）/ `direct`（DM）/ `my`（マイチャット）の 3 種別。`room_id` で識別 |
| 種別集約チャンネル | ルーム単位の紐付けが無い場合に、種別（group/direct）ごとにまとめて投稿するフォールバック Slack チャンネル |
| 紐付け済みルーム | `chatwork_rooms.slack_channel_id` が設定され専用チャンネルへ投稿されるルーム |
| 署名検証 | webhook が Chatwork 由来であることを HMAC-SHA256 で確認する処理 |
| 冪等性 | 同じ webhook を複数回受けても結果（保存・投稿）が 1 回分になる性質 |

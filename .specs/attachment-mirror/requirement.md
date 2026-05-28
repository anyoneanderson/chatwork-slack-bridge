# 要件定義書 - attachment-mirror（Chatwork 添付ファイルを Slack に再アップロード）

> 対象 Issue: [#18 \[Enhancement\] attachment-mirror — Chatwork 添付ファイルを Slack に再アップロード](https://github.com/anyoneanderson/chatwork-slack-bridge/issues/18)
> 参照: `.specs/sender-name/`（実装・本番稼働済み）, `.specs/forwarding/`, `chatwork-slack-bridge-overview.md`, `docs/coding-rules.md`, `docs/review_rules.md`
> 前提: `#3 forwarding` / `#17 sender-name` 実装済み（`chatwork_rooms` / `chatwork_messages` / `chatwork_room_members` / chatwork client / slack client / render-body / forward-message）

## 1. 概要

forwarding + sender-name で Slack に転送されるメッセージのうち、**添付ファイル**は現状「`📎 ファイル名 (サイズ)`」のテキスト表示のみ（#17 で実装した (A) 表示）に留まる。Slack を見た人は中身を確認するために Chatwork を開く必要があり、せっかくの集約効果が削がれる。

本 Issue では **Chatwork 添付ファイルの実体を取得し Slack に再アップロード**することで、Slack 上だけで画像プレビュー / ファイルダウンロードが完結する状態を実現する（Issue #18 が想定する (B) ミラーリング）。

実例（#17 時点）:

```
[Chatwork] サンプルルーム
山田太郎:
📎 ブロック追加画面.png (148.62 KB)
<...|Chatworkで開く>
```

↑ ファイル名表示のみ。本 Issue 完了後は、同じ Slack 投稿のスレッドに `ブロック追加画面.png` の実体がアップロードされ、Slack だけでプレビューできる。

### スコープ外（本 Issue では作らない）

- Slack → Chatwork の添付ファイル転送（#4 slack-reply の後続）
- Slack の Block Kit による表示強化・Markdown プレビュー
- 添付の再ダウンロード / バックアップ（Slack 側にミラーされたら Chatwork 側は不変）
- Chatwork 側の添付削除に追従して Slack 側も削除する同期
- 画像のサムネイル生成・リサイズ
- ウイルススキャン・コンテンツポリシーチェック
- 大容量ファイル（Slack 上限超過）の分割・外部ストレージ経由ホスティング
- マルチトークン Webhook 管理（#24）

## 2. 機能要件

### [REQ-001] Chatwork ファイルダウンロード API（`getFileDownloadUrl`）

- chatwork adapter の薄い client に `getFileDownloadUrl(roomId, fileId)` を追加し、
  `GET /rooms/{room_id}/files/{file_id}?create_download_url=1` を `X-ChatWorkToken` で呼ぶ。
- レスポンスから以下を取り出して返す:
  - `download_url`（短命 URL。**約30秒の有効期限**前提 / ASM-001）
  - `filename`（ファイル名）
  - `filesize`（バイト数）
- レスポンスの `file_id` は **`number | string` のどちらかで返りうる**ため、内部で `String(...)` 化して扱う（既存 `getRoomMembers` の `account_id` 変換と方針統一）。
- 失敗時（認可・レート制限・404・ネットワーク・不正レスポンス）は `ChatworkApiError`（既存）を throw。
  **トークン・本文・短命 URL・ファイル名をエラー/ログに含めない**（NFR-002）。
- ユーザーストーリー: 開発者として、添付ファイルの一時 URL とメタを安全に取得したい。

### [REQ-002] Chatwork ファイルバイト取得（`downloadFile`）

- chatwork adapter の薄い client に `downloadFile(downloadUrl)` を追加。短命 URL に対して
  `GET`（ヘッダ無し）でアクセスし、レスポンス本体を `{ bytes: Uint8Array, mimeType: string | null }` で返す。
- `download_url` は**短命**かつ**認証無しでも開ける**ため、`X-ChatWorkToken` ヘッダは付けない（付けるとリダイレクト先で 400 が返るケースがある / ASM-001）。
- レスポンスの `Content-Type` をそのまま `mimeType` に保持（取得できない/壊れた場合は null）。
- メモリ使用量を抑えるため、本フェーズでは **`arrayBuffer()` で一括取得**する（NFR-006 で 100MB 上限を担保）。
  ストリーミング実装は YAGNI（後続最適化）。
- **サイズ上限の三段防御**: ① `getFileDownloadUrl` の `filesize` メタで事前判定 → ② レスポンスの `Content-Length` ヘッダで事前判定 → ③ `arrayBuffer()` 後の **`bytes.byteLength` で実バイト長を最終検証**（Content-Length 欠落・不正・過小申告に対する保険）。いずれの段階でも `NFR-006` 上限超過時は `ChatworkApiError` を throw。
- 失敗時は `ChatworkApiError` を throw。**URL・バイト本体をログ/エラーに含めない**。
- ユーザーストーリー: 開発者として、Slack に渡すためのファイルバイトを安全に取得したい。

### [REQ-003] Slack ファイルアップロード API（`uploadFile`）

- slack adapter の薄い client に `uploadFile` を追加し、`@slack/web-api` の **`files.uploadV2`** を呼ぶ。
- 入力: `{ channelId, threadTs, filename, mimeType?, bytes }`（`threadTs` は本フェーズは必ず付与 / REQ-005）。
  `bytes` は `Uint8Array`（呼び出し側の型）で受け取り、adapter 内部で **`Buffer.from(bytes)` に変換**して SDK に渡す（`@slack/web-api ^7.16.0` の `file` 引数型は `Buffer | Stream | string` のため / ASM-003）。
- 戻り値: `{ slackFileId: string }`。`files.uploadV2` のレスポンスは `{ ok, files: FilesCompleteUploadExternalResponse[] }` で、各要素が `files?: [{ id }]` を持つ**入れ子構造**。adapter 内部で `response.files[0].files[0].id` を抽出する（旧 SDK 形 `{ file: { id } }` / `{ files: [{ id }] }` も保険として両形対応）。
- 失敗時（API エラー・例外・`ok: false`・`file.id` 欠落）は `SlackApiError`（既存）を throw。**bot token・ファイル名・バイトをエラーに含めない**
  （操作名 / チャンネル ID / Slack エラーコードのみ。既存 SlackApiError 規約に統一）。
- ユーザーストーリー: 開発者として、取得したファイルを Slack に安全にアップロードしたい。

### [REQ-004] 添付付きメッセージの抽出（`extract-attachments`）

- 本文中の `[download:fileId]ファイル名 (サイズ)[/download]` トークンから **file_id を抽出**する純粋関数を追加する。
- 1メッセージに複数添付が含まれる可能性に対応（配列で返す）。
- 抽出結果は `{ fileId: string }[]`（ファイル名・サイズは Chatwork API で改めて取得するため抽出時点では捨ててよい / ASM-002）。
- 既存 `render-body.ts` の動作（`📎 ファイル名 (サイズ)` への整形）は**変更しない**（CON-001）。抽出は別関数として分離する。
- ユーザーストーリー: 開発者として、本文から添付の存在を判定したい。

### [REQ-005] 添付ミラーリング結線（`forward-message` 拡張）

- `forward-message` の Slack 投稿成功後（既存 §6）に、添付ミラー処理を**割り込み追加**する:
  1. 本文から file_id 群を抽出（REQ-004）
  2. 各 file_id について、`chatwork_message_attachments` テーブルで「既にアップロード済か」を判定（REQ-007）
  3. 未アップロードのみ、Chatwork で `getFileDownloadUrl` → `downloadFile` → Slack `uploadFile`（**`thread_ts` = 本文投稿の `slack_ts`** / 設計確定: スレッド添付）
  4. 成功時は `chatwork_message_attachments` に `(chatwork_message_id, chatwork_file_id, slack_file_id)` を記録（REQ-007）
  5. 失敗時は **テキスト表示のまま転送継続**（CON-001 非破壊 / REQ-006）。次回 webhook 再送時のリトライは ops-safety（#5）の領域とし、本 Issue では即時1回トライのみ
- 本文の `📎 ファイル名 (サイズ)` は**そのまま残す**（CON-001 非破壊 / 設計確定: render-body は不変）。
  添付がアップロードされた場合は、Slack 本文 + スレッドの添付という二段表示になる。
- 既存の forwarding / sender-name フロー（ルーム解決 / my skip / 重複保存 / Slack 投稿 / ts UPDATE）は**壊さない**。
- ユーザーストーリー: 利用者として、Chatwork に添付された画像/ファイルを Slack でも実体として閲覧したい。

### [REQ-006] 失敗時フォールバック

- 添付ミラー処理の失敗は **転送を止めない**:
  - Chatwork ファイル取得失敗（404 / 認可 / ネットワーク / レスポンス不正）
  - Chatwork ファイルサイズが上限超過（NFR-006 の 100MB）
  - Slack アップロード失敗（上限超過 / API エラー / ネットワーク）
- 失敗時は (#17 で実装済の) **`📎 ファイル名 (サイズ)` テキスト表示が本文側に残る**ため、Slack を見た人は Chatwork でファイルを開ける（fallback 経路が既に確保されている）。
- 失敗イベントは構造化ログ（識別子のみ。`op` / `roomId` / `messageId` / `fileId` / `kind`）に残す。
  本文・ファイル名・URL・トークン・バイトはログに出さない（NFR-002）。
- ユーザーストーリー: 運用者として、添付処理の失敗が転送フロー全体を止めないことを保証したい。

### [REQ-007] 添付マッピング永続化（`chatwork_message_attachments` テーブル追加）

- 新テーブル `chatwork_message_attachments` を migration で追加する:
  - 主キー: `bigint generated always as identity`
  - `chatwork_message_id`（FK → `chatwork_messages.id`）+ 明示 index
  - `chatwork_file_id`（Chatwork 側のファイル ID。`text`）
  - `slack_file_id`（Slack `file.id`。`text`）
  - `slack_channel_id`（投稿先チャンネル。`text`）
  - `slack_thread_ts`（本文投稿の ts。`text`）
  - `created_at` / `updated_at`（`timestamptz`）
  - `unique (chatwork_message_id, chatwork_file_id)` で **upsert の冪等性**を担保（同じ (message, file) を 2 回 insert しても 1 行のみ）
- **本テーブルの冪等性スコープ**:
  - ✅ **webhook 再送**（同じ Chatwork メッセージが 2 回届く）→ 既存 `chatwork_messages` の `onConflictDoNothing` で `forwardMessage` が早期 return するため、本テーブルへは到達しない（**既存 message dedup に乗っかる**設計）
  - ✅ **mapping の二重 insert**（同 message + 同 file の重複登録）→ `unique` 制約で防止
  - ❌ **並行 worker による同 file の二重 Slack アップロード**（マルチインスタンス + 同時 webhook の極稀ケース）→ 本テーブル単独では防げない。`SELECT で未登録確認 → Slack upload → insert` の順なので、claim 機構なしでは両 worker が Slack へアップロードしうる（DB insert のみ片方が落ちる）
- **本 Issue は webhook 再送までを保証スコープ**とし、上記 ❌ の並行 retry exactly-once は **`ops-safety`（#5）の retry queue 設計の領域**として後続に落とす。現状は単一 Cloud Run インスタンス + synchronous webhook 処理のため実害は無視できる（運用観察で監視）。
- ユーザーストーリー: 運用者として、webhook 再送による添付の二重アップロードを防ぎ、Slack 側にどのファイルが流れたかを追跡したい。

### [REQ-008] Slack 権限スコープ追加と再インストール

- Slack App の bot scope に **`files:write`** を追加し、ワークスペースへ再インストールする手順を `docs/setup-guide/` 配下に追記する。
- 既存スコープ（`chat:write` 等）は維持し、再インストール時の影響範囲（ボットトークンの変更）を手順に明記する。
- ユーザーストーリー: 運用者として、本機能をデプロイする前に必要な Slack 設定変更を1ページで把握したい。

## 3. 非機能要件

### [NFR-001] アダプタ境界

- Chatwork ファイル取得 API は `src/adapters/chatwork/`、Slack アップロード API は `src/adapters/slack/` に閉じる。
- 抽出関数（REQ-004）は Chatwork 由来データの解析のため `src/adapters/chatwork/` に置く（`render-body.ts` と隣接）。
- 結線（REQ-005）は `src/app/services/forward-message.ts`（既存）に集約。
- `src/app/routes/*` から SDK / fetch を直接呼ばない（coding-rules `[MUST]`）。

### [NFR-002] 秘密・本文の非ログ

- `CHATWORK_API_TOKEN` / `SLACK_BOT_TOKEN` は secret adapter 経由。
- ログ・例外メッセージに以下を**出さない**:
  - 各種トークン
  - `download_url`（短命 URL は秘匿前提）
  - ファイルバイト（バイナリ）
  - ファイル名
  - 本文
- ログに出してよい: `op` / `chatworkRoomId` / `chatworkMessageId` / `chatworkFileId` / Slack `channelId` / Slack エラーコード / HTTP ステータス / バイト数（サイズのみ）

### [NFR-003] テスト（coding-rules `[MUST]` / カバレッジ 80%）

- 必須テスト:
  - `getFileDownloadUrl`: 正常マップ / 非2xx（401/404/429/500）→ `ChatworkApiError` / トークン・URL・ファイル名非漏洩 / 不正レスポンス形状
  - `downloadFile`: 正常取得 / `Content-Type` 反映 / ネットワーク失敗 → `ChatworkApiError` / バイト・URL 非ログ
  - `uploadFile`: 正常レスポンスから `file.id` 抽出 / `ok: false` → `SlackApiError` / SDK 例外 → `SlackApiError` / token・ファイル名非漏洩 / `thread_ts` 渡し
  - `extract-attachments`: 0/1/複数添付 / 整形外文字 / `[preview]` 単独（download なし）/ 不正トークン（壊さない）
  - `forward-message`: 添付付きメッセージで mirror が走る / 添付なしでスキップ / 既アップロード（`chatwork_message_attachments` ヒット）でスキップ / ファイル取得失敗で fallback / サイズ上限超過で fallback / Slack アップロード失敗で fallback / 既存フロー（forwarding / sender-name）非破壊
- Chatwork API / Slack API / DB はアダプタ境界でモック。外部ネットワーク非依存。

### [NFR-004] 冪等性（webhook 再送のみ保証）

- 保証スコープ:
  - ✅ webhook 再送 → 既存 `chatwork_messages` の `onConflictDoNothing` で吸収（forwardMessage が早期 return）
  - ✅ mapping 二重 insert → `chatwork_message_attachments` の `unique (chatwork_message_id, chatwork_file_id)` で防止
- 保証スコープ外（**本 Issue では扱わない**、ops-safety #5 の領域）:
  - ❌ 並行 worker による同 file の二重 Slack アップロード（claim 機構が必要）
  - ❌ 「本文投稿成功 → 添付処理途中失敗 → webhook 再送なし」の retry（即時 1 回トライのみ）
- 本 Issue では mapping テーブルだけ用意して将来の retry / claim 設計に備える（テーブル設計は将来追加 `status` カラム / advisory lock を妨げない汎用形）。

### [NFR-005] 整合性（既存 §NFR-005 の延長）

- 添付ミラー処理は **本文 Slack 投稿成功・`slackTs` UPDATE 成功後**に行う（順序固定）。
- 添付処理が部分失敗（一部ファイルだけアップロード成功）しても、成功分のみ `chatwork_message_attachments` に記録する（失敗分は記録しない＝再試行可能な状態）。
- 添付処理の失敗で本文転送をロールバックしない（一度投稿した Slack 本文は消さない）。

### [NFR-006] ファイルサイズ上限（三段防御）

- **1 ファイルあたり 100MB** を上限とする（設計確定）。Slack の `files.uploadV2` は仕様上 1GB だが、メモリ一括取得（REQ-002）と Cloud Run のメモリ設定を踏まえた保守的閾値。
- 上限超過は次の **三段防御**で検知する:
  1. `getFileDownloadUrl` のレスポンス `filesize`（API メタ）
  2. `downloadFile` の `Content-Length` ヘッダ
  3. `arrayBuffer()` 後の **`bytes.byteLength` 実バイト長**（Content-Length 欠落・不正・過小申告に対する保険）
- どの段階でも超過判定なら以降の処理を停止し、(A) テキスト表示にフォールバック（REQ-006）。
- 早期に止めることで Slack へ大容量バイトを送らず、メモリ・帯域・時間の浪費を防ぐ。

### [NFR-007] パフォーマンス

- 1メッセージに複数添付がある場合、**逐次処理**で十分（並列化は YAGNI）。
- Cloud Run のリクエストタイムアウト（デフォルト 5 分）に収まる前提。100MB × N 件で危険な場合は将来のキュー化（#5）で扱う。

## 4. 制約事項

### [CON-001] forwarding / sender-name 非破壊

- 既存の `forward-message` フロー（ルーム解決 → my skip → 名前解決 → `onConflictDoNothing` 保存 → resolveTarget → Slack 投稿 → ts UPDATE）と本番挙動を壊さない。
- 添付処理は **Slack 投稿成功・ts UPDATE 成功の後**に**割り込み追加**する。
- `render-body.ts` の `[download:fileId]` → `📎 ファイル名 (サイズ)` 整形は変更しない（テキストフォールバック経路として現役）。

### [CON-002] OSS / 秘密情報・実値（fixture 限定）

- **fixture / コミット成果物**に実値を残さない:
  - 実 account_id・実名・実ファイル名・本文・実 room/channel ID・実 file_id・実バイナリ
- **ログには識別子（roomId / messageId / fileId / channelId / Slack エラーコード / HTTP ステータス / バイト数）を出してよい**（NFR-002 と整合 / 既存 `forward-message.ts` が同方針で稼働中）。
- テストはダミー値（既存 sender-name / forwarding の CON 踏襲）。
- 画像 fixture が必要な場合はプロジェクト無関係のダミー画像（例: 1×1px PNG）を使う。

### [CON-003] Git / ブランチ

- フィーチャーブランチで作業（例: `feature/attachment-mirror`）。
- Conventional Commits（英語、coding-rules `[MUST]`）。
- spec PR と実装 PR を分離（既存 #15/#16, #20/#21 と同様）。

### [CON-004] Slack スコープ変更の運用影響

- `files:write` 追加には Slack App の再インストールが必要。再インストール時に bot token が変わるため、デプロイ前に Secret Manager の `SLACK_BOT_TOKEN` を更新する必要がある。手順を `docs/setup-guide/` に明記する（REQ-008）。

## 5. 前提条件

### [ASM-001] Chatwork ファイル API の挙動

- `GET /rooms/{room_id}/files/{file_id}?create_download_url=1` は次を返す:
  - `file_id` / `account_id`（アップロード者）/ `message_id` / `filename` / `filesize`（bytes）/ `upload_time` / `download_url`
  - `download_url` は約 **30 秒**で失効
- `download_url` には認証ヘッダを付けず GET する（公式仕様 / `X-ChatWorkToken` を付けるとリダイレクト先で 400 を返すケースあり）。
- 取得失効時の挙動は API レスポンス検証で吸収（再取得は本 Issue では未対応 / fallback に倒す）。

### [ASM-002] 抽出記法

- 本文中の添付参照は `[download:fileId]ファイル名 (サイズ)[/download]` 記法で来る（`render-body.ts` のテスト fixture と一致）。
- `[preview id=fileId ht=...]` は `[download]` とセットで出るため、抽出は `[download:]` のみを対象とする（重複抽出回避）。
- ファイル名・サイズは Chatwork API（REQ-001）で取得する権威値を使う（本文記法は表示用・抽出時は捨ててよい）。

### [ASM-003] Slack `files.uploadV2`

- `@slack/web-api ^7.16.0`（`package.json` 現行版）の `files.uploadV2` を使う（`files.upload` は deprecated）。
- 必要スコープ: `files:write`。
- 引数:
  - `channel_id` / `thread_ts`（必ず付与 / REQ-005）
  - `filename`
  - `file`: **`Buffer | Stream | string`**（SDK 型定義）。adapter で `Uint8Array` を受けたら `Buffer.from(bytes)` に変換する
  - `initial_comment`: 使わない（本文は別途 `chat.postMessage` 既存フロー）
- 戻り値構造（現行 SDK の正規形）:
  ```
  { ok: true, files: FilesCompleteUploadExternalResponse[] }
    where FilesCompleteUploadExternalResponse = { ok, files?: [{ id, ... }], ... }
  ```
  → `response.files[0].files[0].id` で Slack file id が取れる **入れ子**構造。
- 旧 SDK 形（`{ file: { id } }` / `{ files: [{ id }] }`）は保険として両形フォールバックを実装するが、テストは**入れ子形を主**にする。
- 実装時に `@slack/web-api` 型定義 / `context7` で最新仕様を再確認する。

### [ASM-004] Slack ファイルサイズ仕様

- Slack `files.uploadV2` の公称上限は 1GB。本プロジェクトでは 100MB（NFR-006）に絞る。

## 6. 受け入れ基準（Issue #18 準拠）

- [ ] 画像/ファイル添付付きの Chatwork メッセージが、Slack 側に**実体としてアップロード**されて見られる
- [ ] 取得は `create_download_url`（短命 URL）経由、トークン・URL・本文・ファイル名・バイトを**ログに出さない**
- [ ] 取得 / アップロード失敗・サイズ超過時は (A) ファイル名表示（`📎 ファイル名 (サイズ)`）にフォールバックし**転送継続**
- [ ] 添付は本文転送投稿の**スレッド**にアップロードされる（メッセージとファイルの対応が視覚的に明確）
- [ ] 同じ webhook を 2 回受けても**同じファイルを 2 回アップロードしない**（`chatwork_message_attachments` の unique 制約）
- [ ] `files:write` スコープ追加と再インストール手順がドキュメント化される
- [ ] 取得・アップロード・フォールバックにテスト（外部 API はモック・カバレッジ 80%）
- [ ] `chatwork-slack-bridge-overview.md` / `docs/setup-guide/` 更新
- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm test` が通る

## 7. 用語集

| 用語 | 定義 |
|------|------|
| 添付ミラーリング | Chatwork に添付されたファイルを取得し、Slack に同じ実体として再アップロードする処理 |
| 短命 URL | `create_download_url=1` で得られる Chatwork ファイル用の **約30秒**有効な署名 URL |
| (A) フォールバック | #17 で実装した「`📎 ファイル名 (サイズ)`」テキスト表示。添付ミラーリング失敗時にもこの表示が本文に残る |
| 添付マッピング | `chatwork_message_attachments` で保持する `(chatwork_message_id, chatwork_file_id) → (slack_file_id, slack_thread_ts)` 対応 |
| スレッド添付 | Slack 本文投稿の `ts` を `thread_ts` に指定して `files.uploadV2` でファイルをスレッド配下に置く方式 |

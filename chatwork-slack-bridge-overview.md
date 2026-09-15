# Chatwork Slack Bridge システム概要

## 目的

Chatwork を日常的に開かずに、クライアントとのやり取りを Slack に集約する。

まずは Chatwork の新着メッセージを Slack に転送し、Slack 上で内容確認・返信案作成・送信確認を行える状態を目指す。将来的には Claude / ChatGPT / MCP から履歴検索、要約、未返信チェック、返信案作成を行えるようにする。

## 基本方針

- Chatwork は入出力先として扱い、普段の操作面は Slack に寄せる。
- Chatwork からの受信は Webhook を使う。
- Chatwork への送信は Chatwork API を使う。
- Slack からの送信は即時投稿ではなく、送信確認を挟む。
- 受信した Chatwork メッセージは自前DBに保存し、後続の検索・要約・重複防止に使う。
- AI は最初から自動送信させず、下書き・要約・未返信検出に使う。
- OSSとして配布しやすいよう、特定クラウド専用ではなく Docker + PostgreSQL で動く構成を基本にする。
- Cloud Run、Neon、Cloud Tasks は推奨デプロイ例またはアダプタとして扱う。

## 全体構成

```text
Chatwork Webhook
  -> Bridge API: Hono app
  -> PostgreSQL
  -> Slack API
  -> Slack channel / thread

Slack action / slash command / thread reply
  -> Bridge API: Hono app
  -> PostgreSQL
  -> Chatwork API
  -> Chatwork room

Claude / ChatGPT / MCP
  -> Bridge API or DB-backed search API
  -> message history / reply drafts / unread checks
```

## 推奨インフラ

OSS本体は以下で動く構成にする。

- Docker
- Node.js
- PostgreSQL
- Slack App
- Chatwork Webhook
- Chatwork API Token

推奨デプロイ例。

- Cloud Run
- Neon PostgreSQL
- Secret Manager
- Cloud Logging

運用が増えてきたら追加するもの。

- Cloud Tasks
  - Slack 投稿や Chatwork 送信のリトライ
  - レート制限対策
  - 遅延実行
- Pub/Sub
  - Webhook受信と後続処理の分離
  - 非同期イベント処理
- Error Reporting / Monitoring
  - 失敗検知
  - Slack通知
- Queue adapter
  - MVP は DB-backed queue でもよい
  - Google Cloud 運用では Cloud Tasks adapter を使う
- Secret adapter
  - ローカル/Docker は `.env`
  - Google Cloud 運用では Secret Manager

## 主要ユースケース

### 1. Chatwork 新着メッセージを Slack に転送

1. Chatwork Webhook が Bridge API に送信される。
2. Bridge API が Webhook 署名を検証する。
3. `room_id`、`message_id`、送信者、本文、送信時刻を PostgreSQL に保存する。
4. Slack の専用チャンネルに投稿する。
5. Slack の `channel_id`、`ts`、`thread_ts` を PostgreSQL に保存する。

Slack 表示例（forwarding + sender-name フェーズ。本文＋メタの text 投稿のみ。アクションボタンは後続フェーズ）。

```text
[Chatwork] 株式会社Example / 案件A
Taro Yamada:
明日のMTGですが、15時に変更可能でしょうか😊
📎 report.pdf (1.2MB)
<https://www.chatwork.com/#!rid1234567-8901234|Chatworkで開く>
```

添付ファイルがある場合は、上の本文投稿の **スレッド**に Chatwork 添付の実体を再アップロードする（attachment-mirror フェーズ / 後述「添付ファイルの取り扱い」）。本文の `📎 report.pdf (1.2MB)` 行はそのまま残り、スレッドに実体が並ぶ二段表示になる。

```text
[Chatwork] 株式会社Example / 案件A          ← 親メッセージ（chat.postMessage）
Taro Yamada:
明日のMTGですが、15時に変更可能でしょうか😊
📎 report.pdf (1.2MB)
<https://www.chatwork.com/#!rid1234567-8901234|Chatworkで開く>
  └─ 🧵 スレッド
       report.pdf  (Slack 上でプレビュー / ダウンロード可能)   ← files.uploadV2 with thread_ts
```

書式は以下のとおり（sender-name フェーズで導入）。

```text
[Chatwork] {ルーム名}
{表示名 or account_id}:
{整形済み本文（[download]→📎、[info]/[title] 展開、絵文字、引用 > など）}
<https://www.chatwork.com/#!rid{room}-{msg}|Chatworkで開く>
```

before / after（sender-name 導入前後）。

```text
# before（forwarding フェーズ時点）
[Chatwork] 株式会社Example / 案件A
9999999:
明日のMTGですが、15時に変更可能でしょうか(blush)
[info][title]ファイル[/title][download:111]report.pdf (1.2MB)[/download][/info]

# after（sender-name フェーズ）
[Chatwork] 株式会社Example / 案件A
Taro Yamada:
明日のMTGですが、15時に変更可能でしょうか😊
ファイル
📎 report.pdf (1.2MB)
<https://www.chatwork.com/#!rid1234567-8901234|Chatworkで開く>
```

> 送信者は webhook payload では `account_id`（数字）しか得られないため、Chatwork メンバー API
> （`GET /rooms/{room_id}/members`）で表示名へ解決し、`chatwork_room_members` テーブルにキャッシュする。
> キャッシュミス時は1メッセージあたり最大1回リフレッシュし、それでも解決できなければ `account_id`
> を表示にフォールバック（`chatwork_messages.sender_name` は null のまま）して転送は止めない。

> アクションボタン（`[返信案を作る] [対応済みにする]` 等）は slack-reply / ops-safety
> 以降で追加する。forwarding フェーズの投稿はトップレベルの text のみで、`slack_thread_ts` は null。

#### 添付ファイルの取り扱い（(A) フォールバック + (B) Slack 再アップロード）

Chatwork メッセージに添付されたファイルは、次の 2 段構えで Slack に届ける（attachment-mirror フェーズ）。

- **(A) テキスト表示（フォールバック）**: sender-name フェーズで導入した `[download:fileId]ファイル名 (サイズ)[/download]` →
  `📎 ファイル名 (サイズ)` の整形。本文側に常に残る（render-body は不変）。Slack を見た人は最低限ファイル名と
  Chatwork ディープリンクから原本へ辿れる。
- **(B) Slack 再アップロード**: 本文投稿の成功後、本文から file_id を抽出し、Chatwork ファイル API
  （`GET /rooms/{room_id}/files/{file_id}?create_download_url=1`）で**約30秒の短命ダウンロード URL** とメタを取得して
  ファイル実体を読み出し、Slack の `files.uploadV2` で**本文投稿の `ts` を `thread_ts` に指定してスレッドに再アップロード**する。
  これにより Slack 上だけで画像プレビュー／ファイルダウンロードが完結する。

処理順と非破壊性。

1. 本文投稿（`chat.postMessage`）が成功し `slack_ts` を保存した**後**に、添付ミラー処理を割り込み実行する
   （forwarding / sender-name フローは壊さない）。
2. 本文から抽出した各 file_id について、`chatwork_message_attachments`（後述）で**既アップロード済みか**を判定し、
   未アップロードのみ取得 → アップロード → マッピング記録する。
3. **失敗時はフォールバック**: ファイル取得失敗（404 / 認可 / ネットワーク）・サイズ上限超過・Slack
   アップロード失敗のいずれでも、本文の (A) テキスト表示が残るため転送は止めない。失敗は識別子のみの
   構造化ログに残す（トークン・本文・短命 URL・ファイル名・バイトは出さない）。

制約と前提。

- **必要 Slack スコープ**: `chat:write` に加えて **`files:write`**。後から追加する場合はワークスペース再インストール
  （= Bot トークン変更）が必要で、Secret Manager の `SLACK_BOT_TOKEN` 更新 + Cloud Run 再デプロイまでがワンセット
  （手順は [`docs/setup-guide/README.md`](docs/setup-guide/README.md) の §7）。
- **ファイルサイズ上限**: 1 ファイル 100MB（API メタの `filesize` → `Content-Length` → 実バイト長の三段防御）。
  超過時は (A) フォールバック。
- **短命 URL** には認証ヘッダを付けず GET する（Chatwork 仕様）。本文・ファイル名・URL・バイトは非ログ。
- **冪等性は webhook 再送まで保証**: 同じメッセージの再送は既存 `chatwork_messages` の `onConflictDoNothing` で
  早期 return し添付処理に到達しない。マッピングの二重 insert は `chatwork_message_attachments` の unique 制約で防ぐ。
  並行 worker による二重アップロードの exactly-once は ops-safety（#5）の領域として後続に残す。
- スコープ外: Slack → Chatwork の添付転送（#4）、サムネイル生成、ウイルススキャン、Chatwork 側削除への同期。

### 2. Slack から Chatwork に返信

安全性を優先し、最初は確認ボタン方式にする。

1. Slack スレッドに返信文を書く。
2. Bot が「Chatworkへ送信しますか？」を表示する。
3. ユーザーが送信ボタンを押す。
4. Bridge API が対象の `room_id` を PostgreSQL から引く。
5. Chatwork API でメッセージを投稿する。
6. Slack スレッドに送信結果を記録する。

送信確認例。

```text
Chatworkへ送信しますか？

送信先: 株式会社Example / 案件A
本文:
明日15時で問題ありません。よろしくお願いいたします。

Actions: [送信する] [キャンセル]
```

### 3. AI に返信案を作らせる

1. Slack の「返信案を作る」ボタンを押す。
2. Bridge API が対象スレッドの前後文脈を取得する。
3. Claude / ChatGPT に返信案を生成させる。
4. Slack スレッドに下書きとして投稿する。
5. 人間が確認・編集して送信する。

### 4. 未返信チェック

毎朝または任意タイミングで、PostgreSQL 上の履歴から未対応候補を抽出する。

判定材料。

- 最新メッセージが相手発信
- Slack 側で `対応済み` が押されていない
- 一定時間以上返信がない
- メンションや疑問文を含む

通知先。

- Slack DM
- Slack 専用チャンネル
- Claude / ChatGPT / Codex の定期チェック

## PostgreSQL データモデル案

> **注記**: 以下は設計の先行スケッチ（案）です。実装済みテーブル（`chatwork_rooms` /
> `chatwork_messages` / `chatwork_room_members` / `chatwork_message_attachments` /
> `outbound_messages` / `delivery_attempts`）の**正となる定義は `src/db/schema.ts` と
> `src/db/migrations/` の Drizzle migration** です。差異がある場合は migration を正とします
> （`outbound_messages` / `delivery_attempts` は slack-reply フェーズの `.specs/slack-reply/design.md`
> §5.1/§5.2 と migration に合わせて更新済み）。`ai_drafts` / `message_embeddings` は未実装の案です。

### `chatwork_rooms`

```sql
create table chatwork_rooms (
  id bigint generated always as identity primary key,
  chatwork_room_id text not null unique,
  room_name text not null,
  room_type text not null check (room_type in ('group','direct','my')),  -- ルーティング判定に使用
  slack_channel_id text,                 -- nullable: null は種別集約フォールバック（未紐付け）
  enabled boolean not null default true,
  default_reply_mode text not null default 'confirm',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

> forwarding フェーズで `room_type`（`group` / `direct` / `my`）列を追加し、`slack_channel_id` を
> nullable にした。`slack_channel_id` が null のルームは種別集約チャンネル
> （`SLACK_DEFAULT_GROUP_CHANNEL_ID` / `SLACK_DEFAULT_DM_CHANNEL_ID`）へフォールバックする。
> 専用チャンネルを設定すると（`slack_channel_id` を埋めると）そのチャンネルへ切り替わる。
> `room_type = my`（マイチャット）は転送対象外（保存も投稿もしない）。

### `chatwork_messages`

```sql
create table chatwork_messages (
  id bigint generated always as identity primary key,
  chatwork_room_id text not null references chatwork_rooms(chatwork_room_id),
  chatwork_message_id text not null,
  chatwork_account_id text,
  sender_name text,
  body text not null,
  sent_at timestamptz not null,
  slack_channel_id text,
  slack_ts text,
  slack_thread_ts text,
  status text not null default 'open',
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chatwork_room_id, chatwork_message_id)
);

create index chatwork_messages_room_sent_at_idx
  on chatwork_messages (chatwork_room_id, sent_at desc);

create index chatwork_messages_status_idx
  on chatwork_messages (status);

-- slack-reply のスレッド逆引き（slack_channel_id = ? AND slack_ts = ?）の一意性・性能を担保する
-- partial unique index。両カラム non-null（= forwarding で Slack 投稿済み）の行に限る。
create unique index chatwork_messages_slack_channel_ts_unique
  on chatwork_messages (slack_channel_id, slack_ts)
  where slack_channel_id is not null and slack_ts is not null;
```

> slack-reply フェーズで `(slack_channel_id, slack_ts)` の **partial unique index**（両カラム non-null）を
> 追加した。返信スレッドの親 `thread_ts` から返信先 `chatwork_room_id` を一意に逆引きするために使う
> （`slack_ts` はチャンネル内で一意。未投稿（null）行は制約から除外し複数 null を許容）。

> `sender_name` は sender-name フェーズで populate されるようになった。Chatwork メンバー API
> （`GET /rooms/{room_id}/members`）で `chatwork_account_id` から解決した表示名を保存する。
> 解決できなかった場合のみ null のまま（Slack 表示は `account_id` フォールバック）。

### `chatwork_room_members`

```sql
create table chatwork_room_members (
  id bigint generated always as identity primary key,
  chatwork_room_id text not null references chatwork_rooms(chatwork_room_id),
  chatwork_account_id text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chatwork_room_id, chatwork_account_id)
);

create index chatwork_room_members_room_idx
  on chatwork_room_members (chatwork_room_id);
```

> sender-name フェーズで追加。`account_id → 表示名` のキャッシュ。webhook payload には送信者名が
> 含まれないため、初出の account_id を見たら Chatwork メンバー API で取得して upsert する
> （1メッセージあたり最大1リフレッシュ）。リフレッシュ時は取得した全メンバーを upsert することで
> 名前変更にも追従する。`chatwork_rooms` と同様に DB に持つことで Cloud Run のマルチインスタンス /
> 再起動でも共有・永続される。

### `chatwork_message_attachments`

```sql
create table chatwork_message_attachments (
  id bigint generated always as identity primary key,
  chatwork_message_id bigint not null references chatwork_messages(id),  -- 内部 PK を参照
  chatwork_file_id text not null,        -- Chatwork 側の file_id（本文から抽出・文字列化）
  slack_file_id text not null,           -- files.uploadV2 が返す file.id
  slack_channel_id text not null,        -- アップロード先チャンネル（監査・将来の retry 用）
  slack_thread_ts text not null,         -- 本文投稿の ts（スレッド添付先）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chatwork_message_id, chatwork_file_id)
);

create index chatwork_message_attachments_message_idx
  on chatwork_message_attachments (chatwork_message_id);
```

> attachment-mirror フェーズで追加。Chatwork 添付を Slack スレッドに再アップロードした対応関係
> （`(chatwork_message_id, chatwork_file_id) → (slack_file_id, slack_thread_ts)`）を保持する。
> FK は単一カラム参照を単純化するため外部 ID ではなく内部 PK `chatwork_messages.id` を指す。
> `unique (chatwork_message_id, chatwork_file_id)` ＋ `onConflictDoNothing` で同一 (メッセージ, ファイル) の
> 二重 insert を防ぎ、webhook 再送時の二重アップロードを抑止する（再送自体は `chatwork_messages` の
> `onConflictDoNothing` で早期 return するため添付処理に到達しない）。`slack_channel_id` / `slack_thread_ts` は
> 実運用では `chatwork_messages` 側と同値だが、ファイル単位の独立性・将来の retry のため重複保持する。
> 並行 worker の exactly-once（claim 機構 / advisory lock / `status` カラム）は ops-safety（#5）の領域。

### `outbound_messages`

```sql
create table outbound_messages (
  id bigint generated always as identity primary key,
  chatwork_room_id text not null references chatwork_rooms(chatwork_room_id),     -- 返信先ルーム（FK + index）
  source_chatwork_message_id bigint
    references chatwork_messages(id) on delete set null,                          -- 返信元の転送メッセージ（traceability。FK + index / 親削除で null 化）
  slack_channel_id text not null,
  slack_thread_ts text not null,                                                  -- 逆引き結果（= 返信先メッセージの slack_ts）のスナップショット
  slack_reply_ts text not null,                                                   -- トリガとなったユーザー返信の ts（冪等キー）
  slack_confirm_ts text,                                                          -- 確認メッセージの ts（chat.update 対象）。投稿後に設定
  slack_user_id text,                                                             -- 返信を書いた本人の Slack user id（送信/キャンセル操作の認可に使う）
  body text not null,
  status text not null default 'pending'
    check (status in ('pending','sending','sent','cancelled','failed')),          -- sending=claim 中間状態 / failed=終端
  chatwork_message_id text,                                                       -- 送信成功時の Chatwork message id
  error_message text,                                                             -- 失敗時の要約（識別子のみ。本文・トークン非含有）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slack_channel_id, slack_reply_ts)                                       -- 冪等キー（Events 再送で同一 reply を二重作成しない）
);

create index outbound_messages_room_idx   on outbound_messages (chatwork_room_id);            -- FK index
create index outbound_messages_source_idx on outbound_messages (source_chatwork_message_id);  -- FK index
create index outbound_messages_status_idx on outbound_messages (status);
```

> slack-reply フェーズで追加。Slack スレッド返信を検出すると `pending` で作成し、送信確認を経て
> Chatwork へ投稿する。状態遷移（`pending → sending → sent/failed` / `pending → cancelled`）の
> 詳細は `.specs/slack-reply/design.md` §5.1/§5.4 を参照。ボタン押下の二重送信は `pending → sending` の
> 条件付き UPDATE claim（`sending` は中間状態）で防ぐ。`failed` は終端で、再送はユーザーのスレッド
> 再返信で別 outbound を作る。送信/キャンセルの認可は押下者 == `slack_user_id`（返信本人）または
> allowlist（`SLACK_ALLOWED_REPLY_USER_IDS`）で行う。

### `delivery_attempts`

```sql
create table delivery_attempts (
  id bigint generated always as identity primary key,
  outbound_message_id bigint not null references outbound_messages(id),  -- FK + index
  result text not null check (result in ('success','failure')),
  http_status integer,                                                   -- Chatwork API の HTTP ステータス（取得できなければ null）
  error_code text,                                                       -- 失敗時の op 名等の識別子（本文・トークン非含有）
  attempted_at timestamptz not null default now()
);

create index delivery_attempts_outbound_idx
  on delivery_attempts (outbound_message_id);
```

> slack-reply フェーズで追加。1 outbound に対する Chatwork 配送試行（成功/失敗）を追記し、配送試行を
> 監査可能にする（coding-rules `[MUST]` 外部送信失敗の記録）。`outbound_messages` の確定状態更新
> （`sent`/`failed`）と同一トランザクションで記録する（design §5.2）。

> スキーマ方針（`docs/coding-rules.md` の「データベース（PostgreSQL / Drizzle）」参照）:
> - 主キーは `bigint generated always as identity`（`serial`/`bigserial` は使わない）。
> - FK カラムには明示的に index を張る（PostgreSQL は自動で張らないため。上記 `delivery_attempts.outbound_message_id` が例）。`ai_drafts` / `message_embeddings` の FK にも同様の index を追加する。
> - `status` 等の可変ビジネス値は `text` のままとし、`CHECK` 制約または lookup テーブルで値を制限する。

### `ai_drafts`

```sql
create table ai_drafts (
  id bigint generated always as identity primary key,
  chatwork_room_id text not null references chatwork_rooms(chatwork_room_id),
  source_message_id bigint references chatwork_messages(id),
  slack_channel_id text,
  slack_thread_ts text,
  prompt text,
  draft_body text not null,
  model text,
  created_by_slack_user_id text,
  created_at timestamptz not null default now()
);
```

## HTTP エンドポイント案

### `POST /chatwork/webhook`

Chatwork Webhook を受ける（forwarding フェーズで実装済み）。公開エンドポイントだが認可は署名検証で担保する。

主な処理（実装済みの順序）。

1. **raw body 取得**: 署名検証はパース前のバイト列に対して行うため、`arrayBuffer()` で raw body を先に取得する。
2. **署名検証**: `X-ChatWorkWebhookSignature` を HMAC-SHA256（timing-safe）で検証する。失敗・欠落は `401`。
3. **JSON パース / バリデーション**: `JSON.parse` を try/catch で捕捉し、壊れた JSON や Zod 検証失敗は
   再送ストーム回避のため `200`（no-op）。`message_created` 以外のイベントも `200`（no-op）。
4. **ルーム解決**: `chatwork_rooms` を `room_id` で検索し、初見なら Chatwork API（`GET /rooms/{id}`）で
   名前・種別を取得して `enabled=true` / `slack_channel_id=null` でキャッシュする（payload に種別が無いため）。
   初見ルームの取得に失敗した場合は保存せず `200`（FK を満たせないため。Chatwork の再送に委ねる）。
   `room_type = my` は保存も投稿もせず `200`。
5. **送信者名解決**（sender-name フェーズで追加）: `chatwork_room_members` を `(room_id, account_id)` で
   参照する。ヒットしなければ `GET /rooms/{room_id}/members` を1回だけ呼び、全メンバーを upsert して
   再参照する。それでも見つからない、または API 失敗時は `account_id` フォールバック（`sender_name` は
   null）で転送は継続する。
6. **重複チェック / 保存**: `unique (chatwork_room_id, chatwork_message_id)` ＋ `onConflictDoNothing` で
   再送を弾き、新規のみ `chatwork_messages` に保存する（冪等）。解決した表示名を `sender_name` に含める。
7. **ルーティング転送**: マトリックス（紐付け済み → 専用チャンネル / 未紐付け → 種別集約 / `enabled=false`
   → 保存のみ）に従い Slack へ投稿し、`slack_channel_id` / `slack_ts` を保存する。投稿時には Chatwork
   記法を可読テキストへ整形（絵文字ショートコード変換・`[info]`/`[title]`/`[download]` 等の展開）し、
   メッセージへのディープリンク（`https://www.chatwork.com/#!rid{room}-{msg}`）を付与する。投稿失敗時
   は保存を維持し（`slack_ts` は null）、ログに記録する（リトライは後続フェーズ）。
8. **添付ミラー**（attachment-mirror フェーズで追加）: 本文投稿成功・`slack_ts` 保存の**後**に、本文から
   file_id を抽出し、`chatwork_message_attachments` で未アップロードのものだけ Chatwork ファイル API
   （`create_download_url=1`）→ Slack `files.uploadV2`（`thread_ts` = 本文の `ts`）でスレッドへ再アップロードし、
   マッピングを記録する。取得・アップロード失敗・100MB 超過時は本文の `📎 ファイル名 (サイズ)` テキスト表示に
   フォールバックして転送は止めない（識別子のみログ）。

### `POST /slack/events`

Slack Events API を受ける。

主な処理。

- Slack 署名検証
- URL verification 対応
- スレッド返信検出
- 送信確認メッセージ作成

### `POST /slack/interactions`

Slack のボタン操作やモーダル送信を受ける。

主な処理。

- 送信確認
- 返信案生成
- 対応済みマーク
- キャンセル処理

### `POST /internal/send-chatwork-message`

Chatwork へ送信する内部API。

Cloud Tasks などの外部キューを使う場合は、このエンドポイントをタスク実行先にする。

## アダプタ境界

OSSとして育てるため、外部サービス依存は薄いアダプタに閉じ込める。

```text
src/
  adapters/
    chatwork/
    slack/
    queue/
    secrets/
    ai/
  app/
    routes/
    services/
  db/
    schema.ts
    migrations/
```

初期実装で用意するアダプタ。

- `chatwork`: Chatwork API / Webhook payload / 署名検証
- `slack`: Slack Web API / request署名検証 / interactive components
- `queue`: DB-backed queue
- `secrets`: environment variables

Google Cloud向けに追加するアダプタ。

- `queue`: Cloud Tasks
- `secrets`: Secret Manager

将来候補。

- `ai`: OpenAI / Claude
- `search`: pgvector / 外部ベクトルDB
- `source`: Teams / LINE WORKS / Discord

## Slack App に必要な機能

- Bot token
- Signing secret
- Incoming message posting
- Interactive components
- Slash commands
- Event subscriptions

必要な Bot スコープ。

- `chat:write` — メッセージ投稿（forwarding）
- `files:write` — Chatwork 添付ファイルの Slack 再アップロード（attachment-mirror / `files.uploadV2`）

> `files:write` を稼働中アプリに後から追加する場合はワークスペース再インストールが必要で、Bot トークンが
> 変わる。Secret Manager の `SLACK_BOT_TOKEN` 更新と Cloud Run 再デプロイまで行うこと
> （[`docs/setup-guide/README.md`](docs/setup-guide/README.md) §7）。

想定コマンド。

```text
/cw send
/cw draft
/cw open
/cw done
/cw pending
```

最初から全部作らず、MVP ではボタン操作中心でよい。

## セキュリティ

必須。

- Chatwork Webhook 署名検証
- Slack request 署名検証
- Chatwork API token は secret adapter 経由で扱う
- Slack bot token は secret adapter 経由で扱う
- PostgreSQL 接続文字列は secret adapter 経由で扱う
- 公開エンドポイントは必要最小限にする
- PostgreSQL には必要なメッセージだけ保存
- ログにAPIトークンや全文メッセージを不用意に出さない

推奨。

- 送信操作は Slack user allowlist で制限
- 送信前確認を必須化
- 送信履歴を保存
- 失敗時は Slack に通知
- ルームごとに有効/無効を切り替え可能にする

## Chatwork 側の注意点

- API token を持つアカウントが対象ルームに参加している必要がある。
- 投稿権限がないルームには送信できない。
- API レート制限を考慮する。
- 過去ログ取得は万能ではないため、受信後は自前DBに保存する。
- 無料プランでもAPI利用は可能とされているが、組織設定によって管理者承認が必要な場合がある。

## Slack 側の注意点

- スレッド返信をすべて自動送信すると誤爆しやすい。
- 最初は確認ボタン方式にする。
- Slack のメッセージ編集と Chatwork 側の編集を同期するかは後回しでよい。
- Slack 側のリアクションや対応済みボタンでステータス管理できると便利。

## MCP / AI 連携の位置付け

MCP はリアルタイム中継の主役ではなく、履歴検索や補助操作に使う。

向いている用途。

- 最近のやり取りを要約する
- 未返信候補を探す
- 返信案を作る
- 特定クライアントとの過去経緯を検索する
- 今日対応すべきChatworkメッセージを一覧化する

向いていない用途。

- Webhook の代替
- 常時リアルタイム監視
- 人間確認なしの自動返信

MCP 用には、Chatwork API を直接叩かせるより、PostgreSQL に保存した履歴を検索する Bridge API を用意する方が扱いやすい。

PostgreSQL に寄せるメリット。

- 未返信判定をSQLで書きやすい
- ルーム、メッセージ、Slackスレッド、送信履歴の関連を扱いやすい
- MCPやAI向けに期間・相手・状態で絞り込みやすい
- 将来的に全文検索、pgvector、分析クエリへ拡張しやすい

将来的にRAG化する場合も、まずは PostgreSQL に `message_embeddings` のようなテーブルを追加し、pgvector で近傍検索する方針にする。

```sql
create table message_embeddings (
  id bigint generated always as identity primary key,
  chatwork_message_id bigint not null references chatwork_messages(id),
  content text not null,
  embedding vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

## MVP スコープ

最初に作るもの。

1. Chatwork Webhook 受信
2. Slack 転送
3. PostgreSQL 保存
4. Slack から送信確認つき返信
5. Chatwork API 投稿
6. 送信結果を Slack スレッドに記録
7. 対応済みボタン

後回しにするもの。

- AI返信案
- MCP検索
- 過去ログ一括取り込み
- 複数Slackチャンネルへの柔軟なルーティング
- Slack → Chatwork の添付転送（#4。Chatwork → Slack の添付ミラーは attachment-mirror フェーズで実装済み）
- Chatwork 側の添付削除に追従した Slack 側の削除同期
- Chatworkメッセージ編集/削除の同期
- Teams 連携

## 実装ステップ案

### Phase 1: OSS MVP

- Hono で `/chatwork/webhook` を作る。
- Chatwork Webhook 署名を検証する。
- PostgreSQL に保存する。
- Slack チャンネルに投稿する。
- Docker Compose でローカル起動できるようにする。

### Phase 2: Slack から返信

- Slack App に interactive components を設定する。
- Slack スレッド返信を検出する。
- 送信確認ボタンを出す。
- Chatwork API で投稿する。
- 送信成功/失敗を Slack に返す。

### Phase 3: 運用安全性

- DB-backed queue を追加する。
- リトライとレート制限対応を入れる。
- allowlist を入れる。
- エラー通知を入れる。
- 対応済み/未対応ステータスを入れる。

### Phase 4: AI/MCP

- PostgreSQL 検索APIを作る。
- 未返信チェックを作る。
- 返信案生成を作る。
- MCP サーバーまたは ChatGPT/Claude 連携を追加する。

### Phase 5: 推奨クラウドデプロイ

- Cloud Run 用 Dockerfile / deploy sample を用意する。
- Neon PostgreSQL の pooled connection 例を用意する。
- Cloud Tasks adapter を追加する。
- Secret Manager adapter を追加する。

## 技術スタック

採用方針。

- Runtime: Node.js
- Language: TypeScript
- HTTP framework: Hono
- DB: PostgreSQL
- ORM / query builder: Drizzle
- Validation: Zod
- Slack API: `@slack/web-api`
- Chatwork API: 薄い自前 client
- Queue: DB-backed queue
- Deploy: Docker

推奨クラウド構成。

- Deploy: Cloud Run
- Hosted PostgreSQL: Neon
- Queue: Cloud Tasks
- Secrets: Secret Manager

Hono を使う理由。

- Webhook受信とJSON API中心の小さなサービスに合う。
- NestJSほど構成が重くない。
- Cloud Run に載せやすい。
- TypeScriptでルーティングとミドルウェアを薄く書ける。

Drizzle を使う理由。

- SQLに近い形で書ける。
- PostgreSQL と相性がよい。
- Cloud Run の小さなAPIで扱いやすい。
- pgvector や生SQL寄りの検索処理を混ぜやすい。
- Prisma よりランタイムが軽く、今回の中継サーバー用途に合う。

DB接続方針。

- PostgreSQL を主DBにする。
- OSS本体は `DATABASE_URL` で任意のPostgreSQLに接続する。
- Cloud Run + Neon では pooled connection を使う。
- 接続文字列は secret adapter 経由で扱う。
- マイグレーションは Drizzle Kit で管理する。

## デプロイ方針

OSS本体は Docker で動く構成を基準にする。

理由。

- Cloud Run、Fly.io、Render、Railway、VPS などに載せやすい。
- 利用者が自分の環境に合わせてホスティング先を選べる。
- Cloud Run は Docker コンテナをそのまま動かせるため、自分用の本番運用にもつなげやすい。

推奨する公開デプロイ例。

- `docker-compose.yml`
  - ローカル開発用
  - アプリ + PostgreSQL
- `Dockerfile`
  - Cloud Run / Fly.io / Render / Railway などで共通利用
- `.github/workflows/deploy-cloud-run.yml`
  - 自分用のCloud Runデプロイ
  - OSS利用者にとっても実運用サンプルになる
- `docs/deploy/cloud-run.md`
  - Google Cloud向け手順
- `docs/deploy/docker.md`
  - Docker単体 / VPS向け手順

## CI/CD 公開方針

GitHub Actions の workflow は公開してよい。

公開してよいもの。

- Docker build 手順
- テスト実行手順
- Drizzle migration チェック
- Cloud Run deploy コマンド
- 必要な環境変数名
- 必要な GitHub Secrets 名
- Google Cloud Workload Identity Federation の利用例

公開しないもの。

- `CHATWORK_API_TOKEN`
- `CHATWORK_WEBHOOK_TOKEN`
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `DATABASE_URL`
- `GCP_SERVICE_ACCOUNT_KEY`
- 実際のSlackチャンネルID（`SLACK_DEFAULT_GROUP_CHANNEL_ID` / `SLACK_DEFAULT_DM_CHANNEL_ID` の実値含む）
- 実際のChatworkルームID
- クライアント名や本文を含むログ・fixture

GitHub Actions では、秘密情報を workflow に直接書かず、GitHub Secrets または GitHub Environments に入れる。

想定するSecrets。

```text
CHATWORK_WEBHOOK_TOKEN
CHATWORK_API_TOKEN
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
SLACK_DEFAULT_GROUP_CHANNEL_ID
SLACK_DEFAULT_DM_CHANNEL_ID
DATABASE_URL
GCP_PROJECT_ID
GCP_REGION
GCP_SERVICE_NAME
GCP_WORKLOAD_IDENTITY_PROVIDER
GCP_SERVICE_ACCOUNT
```

forwarding フェーズで追加した env / Secrets（secret adapter 経由で注入。ローカル/Docker は `.env`、
Google Cloud は Secret Manager）。

- `CHATWORK_WEBHOOK_TOKEN`: Webhook 署名検証用トークン（base64）。
- `CHATWORK_API_TOKEN`: ルームメタ取得（`GET /rooms/{id}`）用トークン。
- `SLACK_BOT_TOKEN`: Slack 投稿（`chat.postMessage`）・添付アップロード（`files.uploadV2`）用 Bot トークン（`chat:write` / `files:write` スコープ）。
- `SLACK_DEFAULT_GROUP_CHANNEL_ID`: `group` 種別の集約フォールバックチャンネル（秘密ではなく設定値）。
- `SLACK_DEFAULT_DM_CHANNEL_ID`: `direct` 種別の集約フォールバックチャンネル（秘密ではなく設定値）。

workflow にはSecret名だけを書く。

```yaml
on:
  push:
    branches: [main]

jobs:
  deploy:
    if: github.repository == 'owner/chatwork-slack-bridge'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}
      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy "${{ secrets.GCP_SERVICE_NAME }}" \
            --project "${{ secrets.GCP_PROJECT_ID }}" \
            --region "${{ secrets.GCP_REGION }}" \
            --source . \
            --allow-unauthenticated
```

補足。

- GCP認証はサービスアカウントJSONより Workload Identity Federation を優先する。
- 自分用の本番デプロイ workflow を公開してもよいが、production環境の値は GitHub Environments / Secrets に閉じ込める。
- OSS利用者向けには、`deploy-cloud-run.example.yml` を別途用意してもよい。
- `if: github.repository == 'owner/chatwork-slack-bridge'` を入れると、fork先で意図せず本番デプロイが走る事故を避けやすい。

## 未決定事項

- ~~Slack での送信UI~~ → **確定: スレッド返信 + 確認ボタン**（slack-reply フェーズで実装済み / `.specs/slack-reply`）
  - 転送メッセージの Slack スレッドへ返信すると、bridge が［送信］/［キャンセル］ボタン付きの確認メッセージを投稿し、押下で Chatwork へ投稿する。
  - 返信スレッドの親（`slack_ts`）から返信先 Chatwork ルームを逆引きできるため、`/cw send` コマンドやモーダル入力（返信先の明示指定が要る）は採用しない。
- AIプロバイダ（未決定）
  - Claude
  - ChatGPT
  - 両方

## 判断メモ

この用途では、既存OSSをそのまま使うより自前で小さく作る方が安全。

理由。

- 既存実装は片方向転送が多い。
- 古い実装が多く、Chatwork v2 / Slack interactive components / Secret Manager / Cloud Run 前提に合わない。
- 業務チャットのため、署名検証・送信確認・監査ログが必要。
- AI連携やMCP連携は自前DBを中心にした方が拡張しやすい。

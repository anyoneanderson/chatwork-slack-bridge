# 要件定義書 - slack-reply（Slack から Chatwork へ送信確認つき返信）

> 対象 Issue: [#4 \[Phase 4\] slack-reply — Slack から Chatwork へ送信確認つき返信](https://github.com/anyoneanderson/chatwork-slack-bridge/issues/4)
> 参照: `.specs/forwarding/`（実装・本番稼働済み）, `.specs/sender-name/`, `.specs/attachment-mirror/`（実装・本番稼働済み）, `chatwork-slack-bridge-overview.md`, `docs/coding-rules.md`, `docs/review_rules.md`
> 前提: `#3 forwarding` / `#17 sender-name` / `#18 attachment-mirror` 実装済み（`chatwork_rooms` / `chatwork_messages` / `chatwork_room_members` / `chatwork_message_attachments` / chatwork client / slack client / forward-message）
> 確定済み設計判断（ユーザー承認 2026-06-06）: **Slack 送信 UI は「スレッド返信 + 確認ボタン」方式**

## 1. 概要

forwarding（#3）により Chatwork のメッセージは Slack のチャンネルへトップレベル投稿され、各投稿は `chatwork_messages.slack_ts` として記録されている。現状この転送は**片方向**で、Slack を見た担当者が Chatwork に返信するには Chatwork を開く必要がある。

本 Issue では **Slack 上の操作だけで Chatwork へ返信**できるようにする。誤爆を防ぐため即時送信はせず、**必ず送信確認を 1 段挟む**（coding-rules `[MUST]` 送信前確認の必須化 / overview 基本方針）。

確定 UI（スレッド返信 + 確認ボタン）の体験:

```
[Chatwork] サンプルルーム            ← #3 forwarding が投稿した親メッセージ（slack_ts を保持）
山田太郎:
お世話になっております。ご確認お願いします。
<...|Chatworkで開く>
 └ （担当者がこのスレッドに返信）了解しました、明日までに対応します   ← Slack のスレッド返信
 └ 🤖 この内容を Chatwork に送信しますか？                            ← bridge が確認メッセージを投稿
      > 了解しました、明日までに対応します
      [ 送信 ]  [ キャンセル ]
   → [送信] 押下 → Chatwork へ投稿 → 確認メッセージを「✅ 送信しました」に更新
```

「スレッド返信」を採用する理由:

- forwarding が既に各 Chatwork メッセージを Slack の 1 投稿（`slack_ts`）として持っており、**返信スレッドの親 = 返信先 Chatwork メッセージ**という対応が自然に取れる（返信先ルームを `slack_ts → chatwork_messages` の逆引きで一意に決定できる）。
- スラッシュコマンド（`/cw send`）やモーダルは返信先ルームの指定をユーザーに強いるが、スレッド返信なら**文脈（どの会話への返信か）が自明**。
- 既存の DB スキーマ（`chatwork_messages.slack_ts` / `slack_channel_id`）をそのまま流用でき、追加の対応表が要らない。

### スコープ（含む / Issue #4 準拠）

- `POST /slack/events`（Slack 署名検証 / `url_verification` 応答 / スレッド返信検出 → 確認メッセージ投稿）
- `POST /slack/interactions`（ボタン操作の署名検証 / 送信確認 / Chatwork 投稿 / キャンセル / 結果記録・通知）
- Slack interactive components（Block Kit のボタン）の利用
- `outbound_messages` / `delivery_attempts` テーブルの migration 追加
- 返信スレッドの親 `slack_ts` から対象 `chatwork_room_id` を逆引きし、Chatwork API でメッセージ投稿
- 送信成功 / 失敗を Slack スレッド（確認メッセージの更新）に記録・通知し、`delivery_attempts` に永続化
- Chatwork client に `postMessage`（`POST /rooms/{room_id}/messages`）を追加
- Slack 署名検証（`SLACK_SIGNING_SECRET`）と、それに伴う config / secret factory / deploy workflow / setup-guide の更新

### スコープ外（本 Issue では作らない）

- Slack → Chatwork の**添付ファイル**転送（attachment-mirror #18 の逆方向。後続）
- AI による返信案の自動生成（overview 未決定事項「AIプロバイダ」/ #6 ai-mcp の領域）
- モーダル入力 UI・スラッシュコマンド `/cw send`（本 Issue では「スレッド返信 + 確認ボタン」に確定）
- メッセージの編集・取り消し（Chatwork の `PUT/DELETE /messages` 連携）
- スレッド以外（チャンネル直下のトップレベル投稿）からの返信トリガ
- 並行 worker / マルチインスタンスでの exactly-once 配送保証（claim 機構・retry queue は ops-safety #5）
- マルチトークン Webhook 管理（#24。返信先ルームのトークンは現状単一 `CHATWORK_API_TOKEN`）
- リアクション（絵文字）による送信トリガ・既読同期

## 2. 機能要件

### [REQ-001] Slack request 署名検証（`verifySlackSignature`）

- slack adapter に署名検証関数 `verifySlackSignature(rawBody, timestamp, signature, signingSecret)` を追加する（`src/adapters/slack/verify-signature.ts`。chatwork の `verify-signature.ts` と対称な配置）。
- Slack の署名仕様に従う: `v0=HMAC-SHA256(signingSecret, "v0:" + timestamp + ":" + rawBody)` を hex で計算し、`X-Slack-Signature` ヘッダ値と **timing-safe** に比較する。
- **リプレイ攻撃対策**: `X-Slack-Request-Timestamp` が現在時刻から **±300 秒（5 分）** を超えてずれている場合は検証前に false を返す。
- **fail closed**: 署名欠落 / timestamp 欠落・不正 / signing secret 空 / 長さ不一致 / 不一致はすべて false を返す（chatwork 署名検証と同方針 / NFR-001）。
- token・signing secret・raw body をログ / 例外に残さない（NFR-002）。
- 検証は `POST /slack/events` と `POST /slack/interactions` の**両エンドポイントで必須**（coding-rules `[MUST]`）。
- ユーザーストーリー: 開発者として、Slack からの正当なリクエストのみを処理し、なりすまし・リプレイを拒否したい。

### [REQ-002] `POST /slack/events`（Events API 受信・スレッド返信検出）

- 新ルート `POST /slack/events` を追加する（`src/app/routes/slack-events.ts`）。
- 処理順:
  1. 署名検証のため raw body（パース前バイト列）を取得し、`verifySlackSignature` で検証。失敗（欠落・リプレイ含む）は処理せず **`401`**（chatwork webhook と同方針 / CON-002）。
  2. raw body を `JSON.parse` → Zod（`safeParse`）で検証。壊れた JSON / 不正ペイロードは本文を出さずログし **`200`**（再送ストーム回避）。
  3. `type === "url_verification"` の場合は `challenge` をそのまま返す（Slack の Events API 初期登録 / Slack 要求仕様）。
  4. `type === "event_callback"` かつ内部 `event.type === "message"` のみ処理。それ以外は `200`（no-op）。
  5. **スレッド返信検出**（REQ-003）に合致したら確認メッセージを投稿（REQ-004）。合致しなければ `200`（no-op）。
- Slack は 3 秒以内の `200` 応答を要求し、非 2xx / タイムアウトで再送する。本ルートは検証・DB・確認メッセージ投稿（API 1 回）を同期実行しても 3 秒に収まる前提とする（現行 webhook と同じ同期モデル）。再送の冪等性は REQ-005 で担保する。
- ユーザーストーリー: 担当者として、転送された Chatwork メッセージの Slack スレッドに返信するだけで、Chatwork への送信フローを開始したい。

### [REQ-003] スレッド返信の判定とルーム逆引き

- 以下を**すべて満たす** `message` イベントのみを「Chatwork への返信候補」とする:
  - `thread_ts` を持つ（スレッド内の返信である）。
  - **bot 自身の投稿でない**（`bot_id` を持たない / `subtype` が未設定の通常ユーザー発言。確認メッセージや forwarding 投稿への自己反応ループを防ぐ）。
  - `subtype` が付くイベント（`message_changed` / `message_deleted` / `bot_message` / `thread_broadcast` 等）は対象外。
  - 親 `thread_ts` と `channel` の組が `chatwork_messages`（`slack_ts = thread_ts AND slack_channel_id = channel`）に存在する（= forwarding が投稿した Chatwork メッセージのスレッド）。
  - **返信本文が非空**であること（`text` を trim して空 / 空白のみは対象外）。空本文を Chatwork `postMessage` に渡すと 4xx になるため、検出段階で no-op にする。
- 逆引きで得た行から **`chatwork_room_id`** と親メッセージ行 id（`source_chatwork_message_id`）を取得する。逆引きに失敗（該当なし）した場合は **no-op で `200`**（bridge 管理外のスレッド）。
- 逆引きの一意性は DB で担保する: `chatwork_messages (slack_channel_id, slack_ts)` に **index（および両カラム non-null の partial unique index）** を migration 0003 で追加する（REQ-005 / design §5）。Slack の `ts` はチャンネル内で一意のため、`limit 1` ではなくデータ制約として一意性を保証する。
- 対象ルームが `chatwork_rooms.enabled = false` の場合は送信を作成せず no-op（coding-rules `[SHOULD]` ルーム単位の有効/無効 / `my` ルームは forwarding 時点で投稿されないため逆引きに乗らない）。
- ユーザーストーリー: 開発者として、返信先の Chatwork ルームをスレッド構造から曖昧さなく決定したい。

### [REQ-004] 送信確認メッセージの投稿（誤爆防止 / `[MUST]` 送信前確認）

- スレッド返信を検出したら、**即時送信せず**、同じスレッドに**確認メッセージ**を投稿する:
  - 返信本文を引用表示し、「この内容を Chatwork に送信しますか？」と問う。
  - Block Kit の `actions` ブロックに **［送信］（primary）** と **［キャンセル］** のボタンを置く。
  - 各ボタンの `value` には対象を一意に識別する `outbound_messages.id` を載せる。`action_id` は `cw_send` / `cw_cancel`（名前付き定数）。
- 確認メッセージ投稿前に `outbound_messages` 行を **`status = pending`** で作成し（REQ-005）、投稿後に得た確認メッセージの `ts` を `slack_confirm_ts` に記録する（後で `chat.update` するため）。返信を書いた Slack ユーザー ID（`slack_user_id`）も作成時に記録する（送信操作の認可に使う / REQ-006・REQ-009）。
- **確認メッセージの投稿に失敗した場合**は、直前に作成した `pending` 行を best-effort で削除し（識別子のみログ）、ユーザーが再返信すれば再度確認フローに乗れるようにする（pending が UI 無しで残留して詰まるのを防ぐ）。
- 返信本文など外部由来テキストを Slack に載せる際は、既存 `format.ts` の `escapeSlackText` と同方針で **Slack 制御シーケンス（`<!channel>` / `<@U…>` 等）をエスケープ**する（NFR-002 / 通知インジェクション対策 / 既存メモリ slack-control-char-escaping）。
- ユーザーストーリー: 担当者として、Chatwork へ送る前に内容を確認し、誤爆を防ぎたい。

### [REQ-005] 送信意図の永続化（`outbound_messages` テーブル追加）

- 新テーブル `outbound_messages` を migration で追加する（詳細は design.md §5）。主な役割:
  - 送信確認〜送信〜結果記録のライフサイクルを表す `status`（`pending` / `sending` / `sent` / `cancelled` / `failed`）を持つ。`sending` は二重送信防止の claim 中間状態（design §4.5）。
  - 返信先 `chatwork_room_id`（FK → `chatwork_rooms.chatwork_room_id` + 明示 index）、トリガとなった Slack 返信メッセージの識別子（`slack_channel_id` / `slack_reply_ts`）、確認メッセージ `slack_confirm_ts`、操作者 `slack_user_id`、送信本文 `body`、成功時の `chatwork_message_id`、失敗時の `error_message` を保持。
  - **冪等性**: `unique (slack_channel_id, slack_reply_ts)` で、同一の Slack 返信に対する確認メッセージの二重作成を防ぐ（Events API の再送 / `X-Slack-Retry-Num` に耐える）。
- 同 migration 0003 で **既存 `chatwork_messages` テーブルに逆引き用の index**（`(slack_channel_id, slack_ts)`、両カラム non-null の partial unique index）を追加する（REQ-003 の一意逆引きを DB で担保 / 既存データ非破壊の index 追加のみ）。
- ボタン押下時の二重送信防止は **状態遷移ガード**で担保する（REQ-006）。
- 本文（`body`）は Slack 投稿先（信頼境界内）と DB には保持するが、**ログには出さない**（NFR-002）。
- ユーザーストーリー: 運用者として、誰が・いつ・どのルームへ・何を送ろうとしたかを追跡し、再送・監査に使いたい。

### [REQ-006] `POST /slack/interactions`（ボタン操作・送信 / キャンセル）

- 新ルート `POST /slack/interactions` を追加する（`src/app/routes/slack-interactions.ts`）。
- 処理順:
  1. 署名検証（REQ-001）。失敗は **`401`**。
  2. `application/x-www-form-urlencoded` の `payload` フィールドを取り出し、`JSON.parse` → Zod 検証。不正は本文を出さずログし `200`。
  3. `action_id` で分岐（`cw_send` / `cw_cancel`。未知の action は no-op `200`）。
  4. `value` の `outbound_messages.id` で対象行を取得。
- **認可（誤操作・他人操作防止）**: `cw_send` / `cw_cancel` を押せるのは、原則 **その確認メッセージに対応する返信を書いた本人**（`outbound_messages.slack_user_id` と押下ユーザーが一致）とする。加えて `SLACK_ALLOWED_REPLY_USER_IDS`（REQ-009）が設定されている場合は **allowlist のユーザーも許可**（管理者例外）。いずれにも該当しない押下は Chatwork へ送らず、**共有確認メッセージは変更せず no-op（識別子のみログ）**とする。
  - **共有メッセージを上書きしない理由（セキュリティ / Codex 指摘反映）**: 確認メッセージはスレッド内の共有メッセージであり、未認可押下で `chat.update` すると、同じスレッドを見られる別ユーザーが他人の pending 確認 UI を破壊したり、送信済 / キャンセル済の結果表示を上書きできてしまう（DoS・監査表示破壊・状態競合）。よって未認可押下は共有メッセージに副作用を与えない。押下者本人へのフィードバック（「権限がありません」）が必要なら、将来 `response_url` / ephemeral による**本人だけに見える通知**で行う（本 Issue では YAGNI）。
- **［送信］（`cw_send`）**:
  - **状態遷移ガード（claim）**: `UPDATE outbound_messages SET status='sending' ... WHERE id=? AND status='pending' RETURNING` 相当で **`pending` のときのみ 1 行を `sending` に claim** する。0 行なら既に sending / sent / cancelled / failed とみなし二重送信しない（ボタン連打・Slack 再送対策 / NFR-004）。
  - claim 成功時のみ `chatworkClient.postMessage(roomId, body)` を呼ぶ（REQ-007）。
  - 成功: `outbound_messages` を `status='sent'` + `chatwork_message_id` に更新し、`delivery_attempts` に成功を記録（**同一トランザクション** / coding-rules `[MUST]` 複数ステップ DB 操作）。確認メッセージを `chat.update` で「✅ 送信しました」に更新（ボタン除去）。
  - 失敗: `outbound_messages` を `status='failed'` + `error_message` に更新し、`delivery_attempts` に失敗（HTTP ステータス等の識別子のみ）を記録（**同一トランザクション**）。確認メッセージを `chat.update` で「❌ 送信に失敗しました。もう一度返信して操作し直してください」に更新する（coding-rules `[MUST]` 外部送信失敗の記録 + Slack 通知）。
    - **`failed` は終端状態**とする。同一 outbound からの再送（同ボタン再押下）は**行わない**（claim 対象は `pending` のみ）。再送したい場合はユーザーが**スレッドに再返信**すると、新しい `slack_reply_ts` で新しい確認フローが始まる（自動 retry / claim 再開は ops-safety #5 の領域）。これによりボタン UI（押下後はボタン除去）と状態遷移の矛盾が生じない。
- **［キャンセル］（`cw_cancel`）**: `pending` のときのみ `status='cancelled'` に更新し、確認メッセージを「🚫 キャンセルしました」に更新（Chatwork へは送らない）。
- **応答境界（Slack 3 秒制約 / NFR-006）**: ack（`200`）は 3 秒以内に返すことを前提とし、`chat.update` までを同期実行する（API 呼び出しは Chatwork 投稿 + Slack 更新の 2 回）。Chatwork 遅延（429 等）で 3 秒を超えて Slack が再送した場合も、**claim（`pending`→`sending`）により再送は no-op となりデータ整合は保たれる**（UX は劣化しうる）。本格的な ack 分離（即時 ack + 非同期処理）は ops-safety #5 の領域とする。
- ユーザーストーリー: 担当者として、ボタン 1 つで Chatwork に送信 / キャンセルでき、結果をその場で確認したい。

### [REQ-007] Chatwork メッセージ投稿 API（`postMessage`）

- chatwork adapter の薄い client に `postMessage(roomId, body)` を追加し、`POST /rooms/{room_id}/messages` を `X-ChatWorkToken` ヘッダ + `application/x-www-form-urlencoded`（`body=<本文>`）で呼ぶ。
- レスポンス `{ "message_id": "<id>" }` を検証して `{ chatworkMessageId: string }` を返す（`message_id` は `number | string` どちらも許容して `String(...)` 化 / 既存 `getRoomMembers` / `getFileDownloadUrl` と方針統一）。
- 失敗時（認可 401/403・レート制限 429・404・ネットワーク・不正レスポンス）は `ChatworkApiError`（既存）を throw。**トークン・本文・ルーム名をエラー / ログに含めない**（操作名 / HTTP ステータスのみ / NFR-002）。
- ユーザーストーリー: 開発者として、確認済みの本文を対象ルームへ安全に投稿したい。

### [REQ-008] Slack client 拡張（確認メッセージ投稿・更新）

- slack adapter の `SlackClient` に以下を追加する（既存 `postMessage` / `uploadFile` は不変。CON-001）:
  - `postMessage` を **Block Kit / `thread_ts` 対応**に拡張する（既存呼び出し互換を保つ）。確認メッセージはスレッド（`thread_ts`）に `blocks`（ボタン付き）で投稿し、戻り `ts` を返す。
  - `updateMessage(channelId, ts, message)`（`chat.update`）を追加し、ボタン押下後に確認メッセージを結果表示へ差し替える。
- 失敗時は `SlackApiError`（既存）を throw。bot token・本文をエラーに含めない（操作名 / チャンネル ID / Slack エラーコードのみ / NFR-002）。
- 既存 `SlackMessage`（`{ text }`）は `blocks?` を任意追加して拡張する（`z.infer` ではなく手書き interface のまま。型とスキーマの二重定義は発生しない）。
- ユーザーストーリー: 開発者として、確認 UI の投稿と結果更新をアダプタ境界の内側だけで完結させたい。

### [REQ-009] 送信操作の allowlist（任意・`[SHOULD]`）

- 環境変数 `SLACK_ALLOWED_REPLY_USER_IDS`（カンマ区切りの Slack user ID。**任意 / 既定は空**）を追加する。
- **既定の認可**（allowlist 未設定でも有効）: ボタンを押せるのは確認対象の返信を書いた本人（`outbound_messages.slack_user_id` と一致）（REQ-006）。これにより、同じスレッドを見られる別ユーザーが他人の確認メッセージを送信 / キャンセルすることを防ぐ。
- allowlist が設定されている場合は、**本人に加えて allowlist のユーザーも許可**（管理者・代理操作の例外）。どちらにも該当しない押下は Chatwork へ送らず、**共有確認メッセージは変更せず no-op（識別子のみログ）**とする（共有メッセージ上書きによる他人 UI 破壊を防ぐため / REQ-006 の理由参照 / coding-rules `[SHOULD]` 送信操作の allowlist）。
- **本キーは任意（optional）**であり、未設定でも起動・動作する（`SLACK_SIGNING_SECRET` のような必須キー追加とは異なり、Cloud Run 起動を壊さない / メモリ required-config-keys-break-cloud-run 参照）。
- ユーザーストーリー: 運用者として、Chatwork へ送れる Slack ユーザーを必要に応じて絞りたい。

### [REQ-010] 設定追加とデプロイ配線（`SLACK_SIGNING_SECRET`）

- **必須**シークレット `SLACK_SIGNING_SECRET` を追加する。これは必須キーの追加であり、**以下をすべて同時に更新しないと本番（Cloud Run / `SECRET_BACKEND=gcp`）起動が失敗する**（メモリ required-config-keys-break-cloud-run）:
  1. `src/config/env.ts` の `ConfigSchema` に `SLACK_SIGNING_SECRET: z.string().min(1)` を追加し、`loadConfig` の `secrets.get` 列にも追加する。
  2. `src/adapters/secrets/factory.ts` で gcp backend のシークレット名 `SLACK_SIGNING_SECRET_SECRET`（`process.env` 直読み）を必須チェック + `secretNames` に追加する。
  3. `.github/workflows/deploy-cloud-run.yml` の deploy step に `SLACK_SIGNING_SECRET_SECRET: ${{ vars.SLACK_SIGNING_SECRET_SECRET }}` を追加し、`--set-env-vars` に `@@SLACK_SIGNING_SECRET_SECRET=...` を加える。
  4. `docs/setup-guide/` に Slack signing secret の取得・Secret Manager 登録・GitHub variable（`SLACK_SIGNING_SECRET_SECRET`）作成・必要スコープ / イベント購読 / Interactivity 設定の手順を追記する。
- `.env.example` / docker-compose の env 列にも `SLACK_SIGNING_SECRET`（と任意の `SLACK_ALLOWED_REPLY_USER_IDS`）を追記する。
- ユーザーストーリー: 運用者として、本機能をデプロイする前に必要な設定変更を漏れなく把握し、起動失敗を避けたい。

### [REQ-011] Slack App 設定（スコープ / イベント購読 / Interactivity）

- `docs/setup-guide/` に以下の Slack App 設定手順を追記する:
  - **Event Subscriptions**: Request URL = `https://<host>/slack/events`、Bot Events に `message.channels`（public チャンネル転送時）/ `message.groups`（private チャンネル転送時）を購読。
  - **Interactivity & Shortcuts**: Request URL = `https://<host>/slack/interactions`。
  - **Bot Token Scopes**: `chat:write`（確認メッセージ投稿・更新。既存）に加え、スレッド本文を Events で受け取るための `channels:history` / `groups:history` を追加。
  - granular permission アプリのため、スコープ追加は「スコープ追加 + 再インストール」で反映され Bot トークンは不変（メモリ slack-granular-app-token-no-rotation。`files:write` 追加時の実績と同様）。**signing secret は再インストールでは変わらない**（App の Basic Information から取得する固定値）。
- ユーザーストーリー: 運用者として、双方向化に必要な Slack App 設定を 1 ページで把握したい。

## 3. 非機能要件

### [NFR-001] セキュリティ境界・アダプタ境界

- Slack 署名検証は `src/adapters/slack/verify-signature.ts`、Chatwork 投稿は `src/adapters/chatwork/client.ts` に閉じる。`src/app/routes/*` / `services/*` から SDK / `fetch` を直接呼ばない（coding-rules `[MUST]`）。
- 署名検証はセキュリティ境界。fail closed（空鍵・欠落・リプレイ・不一致は false）。公開エンドポイントは `/health` / `/chatwork/webhook` / `/slack/events` / `/slack/interactions` に限定し最小化する（coding-rules `[MUST]` 公開エンドポイント最小化）。
- `/slack/events` は Chatwork webhook と同様に **公開**（`allow-unauthenticated`）であり、認可は署名検証のみで担保する。

### [NFR-002] 秘密・本文の非ログ

- `SLACK_SIGNING_SECRET` / `SLACK_BOT_TOKEN` / `CHATWORK_API_TOKEN` は secret adapter 経由。
- ログ・例外メッセージに**出さない**: 各種トークン・signing secret・返信本文（`body`）・送信者表示名・Slack 制御文字を含む生テキスト・raw リクエストボディ。
- ログに出してよい: `op` / `chatworkRoomId` / `chatworkMessageId`（成功時の戻り）/ `slackChannelId` / `slackTs` / `slackUserId` / `outboundMessageId` / `status` / Slack エラーコード / HTTP ステータス。

### [NFR-003] テスト（coding-rules `[MUST]` / カバレッジ 80%）

- 必須テスト（coding-rules `[MUST]` 重要ロジックのテスト = Slack 署名検証 / Chatwork 送信フロー）:
  - `verifySlackSignature`: 正当署名 = true / 改竄・欠落・signing secret 空 = false / timestamp スキュー超過（リプレイ）= false / 長さ不一致 = false / token・secret 非漏洩。
  - `postMessage`（chatwork）: 正常マップ（`message_id` の number/string 両方）/ 非 2xx（401/403/404/429/500）→ `ChatworkApiError` / トークン・本文非漏洩 / 不正レスポンス形状。
  - Slack client `postMessage`（blocks/thread_ts）/ `updateMessage`: 正常 / `ok:false` → `SlackApiError` / SDK 例外 → `SlackApiError` / token・本文非漏洩。
  - `/slack/events`: 署名失敗 → 401 / `url_verification` → challenge 返却 / 非対象イベント → 200 no-op / スレッド返信検出 → 確認メッセージ投稿 + `outbound_messages` pending 作成 / 逆引き不一致 → no-op / disabled ルーム → no-op / 再送（同 reply ts）→ 二重作成しない / bot 自身の投稿 → no-op。
  - `/slack/interactions`: 署名失敗 → 401 / `cw_send` 正常（claim → Chatwork 投稿 → sent + delivery_attempts 成功 + chat.update）/ Chatwork 失敗 → failed + delivery_attempts 失敗 + chat.update / 二重押下（pending でない）→ 二重送信しない / `cw_cancel` → cancelled / allowlist 外 → 拒否（REQ-009）。
  - 送信フローの DB 整合: `outbound_messages` 更新と `delivery_attempts` 記録が同一トランザクション。
- Chatwork API / Slack API / DB はアダプタ境界でモック。外部ネットワーク非依存。

### [NFR-004] 冪等性 / 二重送信防止

- 保証スコープ:
  - ✅ **Events API 再送**（同一 reply の `message` イベントが複数回届く / `X-Slack-Retry-Num`）→ `outbound_messages` の `unique (slack_channel_id, slack_reply_ts)` で確認メッセージを二重作成しない。
  - ✅ **ボタン連打 / interactions 再送** → `pending` の状態遷移ガード（条件付き UPDATE claim）で Chatwork へ二重投稿しない。
  - ✅ **Chatwork 投稿後に確定更新が落ちた稀ケース**: claim 後 `status='sending'` のまま残留する。`sending` は claim 対象外（claim は `pending` のみ）のため **再送（二重投稿）は起きない**（安全側）。
- 保証スコープ外（**本 Issue では扱わない** / ops-safety #5）:
  - ❌ 並行 worker / マルチインスタンスでの厳密な exactly-once（advisory lock / retry queue が必要）。現状は単一 Cloud Run インスタンス + 同期処理のため実害は無視できる（運用観察）。
  - ❌ `sending` 残留（投稿済み・確定更新失敗）の自動回復。専用 `op` ログで検出でき、人手 / #5 の retry/timeout 設計で扱う（自動 retry は本 Issue 対象外）。

### [NFR-005] 整合性

- `outbound_messages` の確定状態更新（`sent`/`failed`）と `delivery_attempts` の記録は **同一トランザクション**で行い、片方だけ残ることを防ぐ（coding-rules `[MUST]`）。
- Chatwork 投稿（外部呼び出し）は claim（`pending`→`sending`）後・確定更新トランザクションの境界外で行い、投稿結果に応じて `sent` / `failed` を確定する。
- **投稿成功後に確定トランザクションが失敗した稀ケース**: `outbound_messages` は `sending` のまま、`delivery_attempts` も記録されない（tx ごとロールバック）。この状態は「投稿済み・記録未確定」を意味し、専用 `op`（例: `slack.outbound.commit_failed`）の構造化ログで検出する。`sending` は claim 対象外のため二重投稿は起きず、自動回復は ops-safety #5 の領域とする（NFR-004 と整合。「成功記録が残る」とは仮定しない）。
- 確認メッセージの `chat.update`（Slack 表示更新）は DB 確定後に行う外部呼び出しであり、失敗しても DB の真実（`status`）は保たれる（識別子のみログ）。

### [NFR-006] パフォーマンス / Slack タイムアウト

- Slack は `/slack/events`・`/slack/interactions` への応答に **3 秒以内の `2xx`** を要求し、超過 / 非 2xx で再送する。本 Issue は同期モデルとし、必要最小限の API（events: 確認投稿 1 回 / interactions: Chatwork 投稿 + chat.update 2 回）のみ実行して 3 秒に収める前提とする（現行 chatwork-webhook と同方針）。
- **3 秒超過時の安全性**: Chatwork 遅延（429 等）で超過し Slack が再送しても、events は `unique (slack_channel_id, slack_reply_ts)`、interactions は claim（`pending`→`sending`）により**再送は no-op となりデータ整合は保たれる**（二重投稿・二重確認しない）。UX（応答の遅さ）は劣化しうるが正しさは守られる。
- 即時 ack + 非同期処理への分離（`response_url` を使った遅延更新やキュー投入）は YAGNI とし、ops-safety #5 でキュー導入時に再検討する。

### [NFR-007] 設定の後方互換

- `SLACK_SIGNING_SECRET` は**必須**追加のため、env / factory / deploy workflow / docs を同時更新する（REQ-010）。
- `SLACK_ALLOWED_REPLY_USER_IDS` は**任意**（既定空）で、未設定でも従来どおり動作する（後方互換）。

## 4. 制約事項

### [CON-001] 既存フロー非破壊

- 既存の forwarding / sender-name / attachment-mirror フロー（`chatwork_messages` の保存・`slack_ts` / `slack_channel_id` 記録・添付ミラー）と本番挙動を壊さない。
- 既存 `SlackClient.postMessage` / `uploadFile` の**シグネチャ互換**を保つ（`postMessage` は `thread_ts` / `blocks` を**任意**追加で拡張）。
- `render-body.ts` / `format.ts` は変更しない（必要な escape ロジックは再利用 / 重複させない）。

### [CON-002] 公開エンドポイントの認可は署名検証のみ

- `/slack/events` / `/slack/interactions` は公開（`allow-unauthenticated`）。署名検証失敗は **401** で拒否する。
- 署名検証を通らないリクエストは DB・外部 API に一切到達させない。

### [CON-003] OSS / 秘密情報・実値（fixture 限定）

- fixture / コミット成果物に実値を残さない: 実 Slack user/channel/ts・実 room ID・実 signing secret・実 bot token・実 Chatwork message_id・本文・クライアント名。
- テストはダミー値（既存 forwarding / attachment-mirror の CON 踏襲）。
- ログには識別子（roomId / messageId / channelId / ts / userId / outboundMessageId / Slack エラーコード / HTTP ステータス）を出してよい（NFR-002 と整合）。

### [CON-004] Git / ブランチ

- フィーチャーブランチで作業（例: `feat/slack-reply`）。Conventional Commits（英語 / coding-rules `[MUST]`）。
- spec PR と実装 PR を分離（既存 #15/#16, #20/#21, #26/#27 と同様）。

### [CON-005] 単一トークン / 単一ルーム前提

- 返信先 Chatwork ルームへの投稿は現状の単一 `CHATWORK_API_TOKEN` を使う。複数ルーム / ルーム別トークンは #24 multi-token-webhook の領域。本 Issue は逆引きで得たルームへ単一トークンで投稿する（投稿先トークンの妥当性は運用前提）。

## 5. 前提条件

### [ASM-001] Slack 署名仕様

- Slack は `X-Slack-Signature: v0=<hex>` と `X-Slack-Request-Timestamp: <unix秒>` を送る。署名は `v0:<timestamp>:<raw body>` に対する HMAC-SHA256（鍵 = signing secret）の hex。
- 署名検証には**パース前の raw body**が必要（chatwork webhook と同様、`c.req.arrayBuffer()` を先に取得する）。
- timestamp が 5 分以上ずれたリクエストはリプレイとして拒否する（Slack 公式推奨）。

### [ASM-002] Slack イベント・インタラクション形

- Events API: `{ type: "url_verification", challenge }` または `{ type: "event_callback", event: { type, subtype?, bot_id?, user, text, ts, thread_ts?, channel } }`。`message` イベントのみ対象。
- Interactivity: `Content-Type: application/x-www-form-urlencoded` の `payload` フィールドに JSON 文字列が入る。`{ type: "block_actions", user: { id }, actions: [{ action_id, value }], message: { ts }, channel: { id } }`。
- 実装時に `@slack/web-api` の型 / Slack 公式 docs / context7 で最新仕様を再確認する。

### [ASM-003] Chatwork メッセージ投稿 API

- `POST /rooms/{room_id}/messages`（`X-ChatWorkToken` ヘッダ + form `body`）はレート制限あり。成功時 `{ "message_id": "..." }` を返す。
- `message_id` は `number | string` どちらでも返りうるため `String(...)` 化する（既存方針）。
- 投稿先ルームに bot アカウントが参加し投稿権限を持つことが前提（未参加 / 権限なしは 4xx → `failed` 記録 + Slack 通知）。

### [ASM-004] forwarding が `slack_ts` を保持していること

- 返信スレッドの親 `thread_ts` から `chatwork_messages.slack_ts` を逆引きできる前提（#3 forwarding が投稿成功時に `slack_ts` / `slack_channel_id` を保存済み）。`slack_ts` UPDATE が落ちた稀なケース（forwarding の `forward.slack.ts_update` ログ）は逆引きに乗らず no-op となる（許容）。

## 6. 受け入れ基準（Issue #4 準拠）

- [ ] Slack request 署名検証が実装され、`/slack/events`・`/slack/interactions` の両方で適用されている（失敗は 401 / リプレイ拒否込み）
- [ ] 転送メッセージの Slack スレッドへの返信から、**送信前に必ず確認**（［送信］/［キャンセル］ボタン）を挟む
- [ ] ［送信］で対象 Chatwork ルームへ投稿され、成功 / 失敗が `outbound_messages` / `delivery_attempts` に記録され、Slack スレッド（確認メッセージ更新）で通知される
- [ ] 同一の Slack 返信を 2 回受けても確認メッセージを二重作成しない / ボタン連打で Chatwork へ二重投稿しない
- [ ] 送信フロー（確認 → 送信 → 結果記録）にテストがある（外部 API はモック / カバレッジ 80%）
- [ ] `SLACK_SIGNING_SECRET` 追加に伴い env / secret factory / deploy workflow / setup-guide が**同時に**更新されている（本番起動が壊れない）
- [ ] Slack App のイベント購読 / Interactivity / スコープ手順がドキュメント化される
- [ ] `chatwork-slack-bridge-overview.md` の未決定事項「Slack 送信 UI」がスレッド返信方式で確定として反映される
- [ ] `pnpm lint` / `pnpm typecheck` / `pnpm test` が通る

## 7. 用語集

| 用語 | 定義 |
|------|------|
| 送信確認 | Slack から Chatwork へ送る前に［送信］/［キャンセル］を 1 段挟む誤爆防止の仕組み（coding-rules `[MUST]`） |
| スレッド返信検出 | forwarding が投稿した Slack メッセージ（`slack_ts`）のスレッドへの人間の返信を検知し、返信先 Chatwork ルームを逆引きする処理 |
| ルーム逆引き | `slack_ts = thread_ts AND slack_channel_id = channel` で `chatwork_messages` を引き、`chatwork_room_id` を得ること |
| 確認メッセージ | スレッドに投稿される Block Kit のボタン付きメッセージ。押下後に `chat.update` で結果表示へ差し替える |
| 状態遷移ガード（claim） | `pending` のときのみ条件付き UPDATE で 1 行を確保し、二重送信を防ぐ仕組み |
| outbound | Slack → Chatwork 方向の送信。`outbound_messages` / `delivery_attempts` が対応 |
| signing secret | Slack App の Basic Information にある署名検証用シークレット（`SLACK_SIGNING_SECRET`）。再インストールで変わらない |

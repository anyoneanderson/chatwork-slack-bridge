import { z } from "zod";

/**
 * Slack Events API の `message` イベント本体のスキーマ（ASM-002 / REQ-002/003）。
 *
 * `subtype` / `bot_id` の有無で「bot 自身の投稿・編集/削除等の派生イベント」を判別する。本フェーズが
 * 対象とするのは通常ユーザーのスレッド返信のみで、判定（`handle-slack-reply`）側で `subtype` なし /
 * `bot_id` なし / `user` あり / `thread_ts` あり / `text` 非空を確認する。スキーマでは Slack が送る形を
 * 緩く受け取り（未知フィールドは無視）、必須は `type` / `ts` / `channel` のみとする。
 *
 * `z.any()` は禁止のため、検証しないフィールドは持たせず未知キーを `strip`（既定）で落とす。
 */
export const SlackMessageEventSchema = z.object({
  type: z.literal("message"),
  /** `message_changed` / `message_deleted` / `bot_message` 等の派生イベント種別（あれば対象外）。 */
  subtype: z.string().optional(),
  /** bot 自身の投稿に付く ID（あれば自己反応ループ防止のため対象外）。 */
  bot_id: z.string().optional(),
  /** 発言ユーザーの Slack user id（通常メッセージは必須だが派生イベントでは欠落しうる）。 */
  user: z.string().optional(),
  /** 返信本文（trim 後の非空判定は判定側で行う）。 */
  text: z.string().optional(),
  /** メッセージの ts（トリガとなった返信の冪等キー）。 */
  ts: z.string().min(1),
  /** スレッド親の ts（= 逆引き対象の forwarding 投稿の slack_ts）。なければスレッド返信ではない。 */
  thread_ts: z.string().optional(),
  /** 投稿チャンネル ID。 */
  channel: z.string().min(1),
});

/** Slack Events API の `event_callback` envelope（内部 `event` に message を含む）。 */
const EventCallbackSchema = z.object({
  type: z.literal("event_callback"),
  event: SlackMessageEventSchema,
});

/** Slack Events API の URL 検証チャレンジ（初期登録時に `challenge` をそのまま返す）。 */
const UrlVerificationSchema = z.object({
  type: z.literal("url_verification"),
  challenge: z.string().min(1),
});

/**
 * Slack Events API の受信エンベロープ（`url_verification` / `event_callback` の discriminated union）。
 *
 * `type` を判別子に持つ discriminated union とし、未知の `type`・不正ペイロードは `safeParse` で
 * 弾く（ルート側で 200 no-op）。`event_callback` の内部 `event` は本フェーズ対象の `message` のみ
 * を受理する（他種別はスキーマ不一致 → no-op）。
 */
export const SlackEventEnvelopeSchema = z.discriminatedUnion("type", [
  UrlVerificationSchema,
  EventCallbackSchema,
]);

/**
 * Slack Interactivity（Block Kit ボタン押下）の `block_actions` payload のスキーマ（ASM-002 / REQ-006）。
 *
 * `application/x-www-form-urlencoded` の `payload` フィールドに入る JSON を検証する。`actions` は
 * 少なくとも 1 要素を要求し、先頭要素の `action_id` で送信/キャンセルを分岐する。`value` には
 * `outbound_messages.id` が載る（欠落時はルート側で no-op）。`message` / `channel` は監査・将来用に
 * 任意で受け取る（未知フィールドは無視）。
 */
export const BlockActionsSchema = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string().min(1) }),
  actions: z
    .array(
      z.object({
        action_id: z.string().min(1),
        value: z.string().optional(),
      }),
    )
    .min(1),
  message: z.object({ ts: z.string().optional() }).optional(),
  channel: z.object({ id: z.string().optional() }).optional(),
});

/** Slack `message` イベント本体の型（`z.infer` 由来。型とスキーマを二重定義しない）。 */
export type SlackMessageEvent = z.infer<typeof SlackMessageEventSchema>;

/** Slack Events API エンベロープの型（`z.infer` 由来）。 */
export type SlackEventEnvelope = z.infer<typeof SlackEventEnvelopeSchema>;

/** Slack `block_actions` payload の型（`z.infer` 由来）。 */
export type BlockActions = z.infer<typeof BlockActionsSchema>;

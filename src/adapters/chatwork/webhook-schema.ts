import { z } from "zod";

/**
 * Chatwork webhook の `message_created` イベント本体（`webhook_event`）のスキーマ（REQ-003）。
 *
 * 送信者 ID は **`account_id`** であり、`from_account_id`（`mention_to_me` 系イベントの項目）とは
 * 別物である点に注意（混同すると実 webhook を弾く / 設計 §6・Chatwork webhook docs）。
 * `room_id` / `message_id` は DB では `text` 列だが、payload では `room_id` が数値・`message_id` が
 * 文字列で届くため、ここでは payload の素の型で検証し、保存時に文字列化・ブランド化する。
 */
export const WebhookEventSchema = z.object({
  account_id: z.number().int(),
  room_id: z.number().int(),
  message_id: z.string().min(1),
  body: z.string(),
  send_time: z.number().int(),
  update_time: z.number().int().optional(),
});

/**
 * Chatwork webhook ペイロード全体のスキーマ（REQ-003）。
 *
 * `webhook_event_type` で配信イベントを判定し、本フェーズは `message_created` のみ処理する。
 * envelope 系フィールド（`webhook_setting_id` / `webhook_event_time`）は将来の互換性のため
 * 任意で受け付ける（未知フィールドは無視）。
 */
export const WebhookPayloadSchema = z.object({
  webhook_setting_id: z.union([z.string(), z.number()]).optional(),
  webhook_event_type: z.string(),
  webhook_event_time: z.number().int().optional(),
  webhook_event: WebhookEventSchema,
});

/** `message_created` イベント本体の型（`z.infer` 由来。型とスキーマを二重定義しない）。 */
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

/** Chatwork webhook ペイロードの型（`z.infer` 由来）。 */
export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

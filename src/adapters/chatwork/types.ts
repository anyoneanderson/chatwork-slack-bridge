/**
 * Chatwork ルーム種別。`GET /rooms/{room_id}` の `type` フィールドと DB の `room_type` 列に対応する。
 *
 * 値は `@/db/schema` を単一の出典として再エクスポートする（リテラルを再定義すると DB の CHECK 制約と
 * ズレる恐れがあるため。レビューで重複リスクとして指摘された箇所）。
 */
export { ROOM_TYPES, type RoomType } from "@/db/schema";

/**
 * Chatwork webhook の対象イベント種別。本フェーズ（forwarding）は `message_created` のみ処理し、
 * `message_updated` / `message_deleted` は no-op とする（スコープ外）。
 */
export const CHATWORK_EVENT_TYPES = [
  "message_created",
  "message_updated",
  "message_deleted",
] as const;

/** Chatwork webhook イベント種別の union 型。 */
export type ChatworkEventType = (typeof CHATWORK_EVENT_TYPES)[number];

declare const chatworkRoomIdBrand: unique symbol;
declare const chatworkMessageIdBrand: unique symbol;

/**
 * Chatwork ルーム ID のブランド型。
 *
 * webhook payload では数値だが DB では `text` 列のため文字列で扱う。素の `string` や
 * `ChatworkMessageId` との取り違えをコンパイル時に防ぐ。
 */
export type ChatworkRoomId = string & { readonly [chatworkRoomIdBrand]: true };

/**
 * Chatwork メッセージ ID のブランド型。
 *
 * 素の `string` や `ChatworkRoomId` との取り違えをコンパイル時に防ぐ。
 */
export type ChatworkMessageId = string & { readonly [chatworkMessageIdBrand]: true };

/**
 * 文字列を `ChatworkRoomId` ブランド型に変換する。
 *
 * @param value ルーム ID 文字列（payload の数値を文字列化したもの等）
 * @returns ブランド付きの `ChatworkRoomId`
 */
export function toChatworkRoomId(value: string): ChatworkRoomId {
  return value as ChatworkRoomId;
}

/**
 * 文字列を `ChatworkMessageId` ブランド型に変換する。
 *
 * @param value メッセージ ID 文字列
 * @returns ブランド付きの `ChatworkMessageId`
 */
export function toChatworkMessageId(value: string): ChatworkMessageId {
  return value as ChatworkMessageId;
}

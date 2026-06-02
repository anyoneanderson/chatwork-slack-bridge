import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Chatwork ルーム種別。Chatwork API の `type` フィールドに対応する。
 * DB の `room_type` 列の CHECK 値と一致させる（型と制約のズレを防ぐ）。
 */
export const ROOM_TYPES = ["group", "direct", "my"] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

/**
 * メッセージの対応ステータス。DB の `status` 列の CHECK 値と一致させる。
 * 進化しうるビジネス値のため enum 型ではなく text + CHECK で表現する（coding-rules [SHOULD]）。
 */
export const MESSAGE_STATUS = ["open", "done"] as const;
export type MessageStatus = (typeof MESSAGE_STATUS)[number];

/**
 * Chatwork ルーム（紐付け・メタキャッシュ）。
 *
 * webhook payload にルーム名・種別が無いため、初見ルームは Chatwork API で取得して
 * ここにキャッシュする。`slack_channel_id` は紐付け済みのみ設定し、null は種別集約
 * フォールバックを意味する（overview の not null から逸脱 / CON-004）。
 */
export const chatworkRooms = pgTable(
  "chatwork_rooms",
  {
    id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
    chatworkRoomId: text("chatwork_room_id").notNull().unique(),
    roomName: text("room_name").notNull(),
    roomType: text("room_type").notNull(),
    // 紐付け済みのみ設定。null は種別集約フォールバック（CON-004）。
    slackChannelId: text("slack_channel_id"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("chatwork_rooms_room_type_check", sql`${table.roomType} in ('group','direct','my')`),
  ],
);

/**
 * Chatwork から受信したメッセージ。
 *
 * `unique (chatwork_room_id, chatwork_message_id)` で webhook 再送の重複を弾く（REQ-005）。
 * `chatwork_room_id` は `chatwork_rooms.chatwork_room_id` への FK のため、初見ルームは
 * 先に親行を作ってから挿入する。
 */
export const chatworkMessages = pgTable(
  "chatwork_messages",
  {
    id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
    chatworkRoomId: text("chatwork_room_id")
      .notNull()
      .references(() => chatworkRooms.chatworkRoomId),
    chatworkMessageId: text("chatwork_message_id").notNull(),
    // payload の account_id（送信者 ID）。
    chatworkAccountId: text("chatwork_account_id"),
    // payload に送信者名は無い。Phase 3 は null 可（名前解決は後続フェーズ）。
    senderName: text("sender_name"),
    body: text("body").notNull(),
    // send_time（epoch）を timestamptz に変換して保存する。
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    slackChannelId: text("slack_channel_id"),
    slackTs: text("slack_ts"),
    // 本フェーズは null（スレッド化は slack-reply 以降）。
    slackThreadTs: text("slack_thread_ts"),
    status: text("status").notNull().default("open"),
    rawPayload: jsonb("raw_payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("chatwork_messages_room_message_unique").on(
      table.chatworkRoomId,
      table.chatworkMessageId,
    ),
    // FK index も兼ねる（PostgreSQL は FK に自動で index を張らない / coding-rules [MUST]）。
    index("chatwork_messages_room_sent_at_idx").on(table.chatworkRoomId, table.sentAt.desc()),
    index("chatwork_messages_status_idx").on(table.status),
    check("chatwork_messages_status_check", sql`${table.status} in ('open','done')`),
  ],
);

/**
 * Chatwork ルームメンバー（account_id → 表示名のキャッシュ）。
 *
 * webhook payload に送信者名が無いため、Chatwork メンバー API で取得した名前をここに
 * キャッシュし、毎回 API を叩かない（レート制限回避）。`chatwork_room_id` は FK で
 * `chatwork_rooms.chatwork_room_id` を参照し、`(chatwork_room_id, chatwork_account_id)`
 * を unique にして冪等 upsert を担保する（REQ-003 / NFR-004）。
 */
export const chatworkRoomMembers = pgTable(
  "chatwork_room_members",
  {
    id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
    chatworkRoomId: text("chatwork_room_id")
      .notNull()
      .references(() => chatworkRooms.chatworkRoomId),
    chatworkAccountId: text("chatwork_account_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("chatwork_room_members_room_account_unique").on(
      table.chatworkRoomId,
      table.chatworkAccountId,
    ),
    // FK index（PostgreSQL は FK に自動で index を張らない / coding-rules [MUST]）。
    index("chatwork_room_members_room_idx").on(table.chatworkRoomId),
  ],
);

/**
 * Chatwork 添付ファイルと Slack 再アップロード結果のマッピング（attachment-mirror design §3.1 / REQ-007）。
 *
 * Slack 本文投稿成功後に Chatwork の添付実体を Slack へ再アップロードした結果を保持する。
 * FK は `chatwork_messages.id`（内部 PK）を単一カラムで参照する（複合 unique を持つ外部 ID より
 * 単純で CASCADE 拡張に強いため / design §3.1）。`(chatwork_message_id, chatwork_file_id)` を unique に
 * して `onConflictDoNothing` による冪等 upsert を担保し、webhook 再送・mapping 二重 insert を防ぐ
 * （REQ-007 / NFR-004）。`slack_channel_id` / `slack_thread_ts` は監査と将来の retry 用に重複保持する。
 */
export const chatworkMessageAttachments = pgTable(
  "chatwork_message_attachments",
  {
    id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
    chatworkMessageId: bigint("chatwork_message_id", { mode: "bigint" })
      .notNull()
      .references(() => chatworkMessages.id),
    chatworkFileId: text("chatwork_file_id").notNull(),
    slackFileId: text("slack_file_id").notNull(),
    slackChannelId: text("slack_channel_id").notNull(),
    slackThreadTs: text("slack_thread_ts").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("chatwork_message_attachments_message_file_unique").on(
      table.chatworkMessageId,
      table.chatworkFileId,
    ),
    // FK index（PostgreSQL は FK に自動で index を張らない / coding-rules [MUST]）。
    index("chatwork_message_attachments_message_idx").on(table.chatworkMessageId),
  ],
);

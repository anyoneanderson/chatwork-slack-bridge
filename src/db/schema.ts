import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
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
 * Slack → Chatwork 送信（outbound）のライフサイクル状態。DB の `status` 列の CHECK 値と一致させる。
 * `pending`=確認待ち / `sending`=claim 済み送信中（二重送信防止の中間状態）/ `sent`=送信成功 /
 * `cancelled`=キャンセル / `failed`=送信失敗（終端。再送はユーザーの再返信で別 outbound を作る）。
 * 進化しうるビジネス値のため enum 型ではなく text + CHECK で表現する（coding-rules [SHOULD]）。
 */
export const OUTBOUND_STATUS = ["pending", "sending", "sent", "cancelled", "failed"] as const;
export type OutboundStatus = (typeof OUTBOUND_STATUS)[number];

/**
 * 配送試行（delivery_attempts）の結果区分。DB の `result` 列の CHECK 値と一致させる。
 * 1 outbound に複数試行を追記して監査可能にする（design §5.2）。
 */
export const DELIVERY_RESULT = ["success", "failure"] as const;
export type DeliveryResult = (typeof DELIVERY_RESULT)[number];

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
    // slack-reply のスレッド逆引き（slack_channel_id = ? AND slack_ts = ?）の一意性・性能を
    // DB で担保する（slack-reply design §5.2b / REQ-003）。両カラム non-null（= forwarding で
    // Slack 投稿済み）の行に限った partial unique index。ts はチャンネル内で一意のため、逆引きの
    // 一意性をデータ制約として保証しつつ、未投稿（null）行は制約から除外して複数 null を許容する。
    uniqueIndex("chatwork_messages_slack_channel_ts_unique")
      .on(table.slackChannelId, table.slackTs)
      .where(sql`${table.slackChannelId} is not null and ${table.slackTs} is not null`),
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

/**
 * Slack → Chatwork 送信（outbound）の意図と結果（slack-reply design §5.1 / REQ-005）。
 *
 * Slack スレッド返信を検出すると `pending` で行を作成し、送信確認を経て Chatwork へ投稿する。
 * 送信確認〜送信〜結果記録のライフサイクル（OUTBOUND_STATUS の状態遷移 / design §5.4）を表現し、
 * 誰が・いつ・どのルームへ・何を送ろうとしたかを監査・再送に使う。
 * `unique (slack_channel_id, slack_reply_ts)` を冪等キーとし、Events API の再送（同一 reply）でも
 * 確認メッセージを二重作成しない（NFR-004）。ボタン押下時の二重送信は `pending`→`sending` の
 * 条件付き UPDATE claim で防ぐ（design §4.5）。`error_message` は要約（識別子）のみで、本文・
 * トークンは含めない（NFR-002）。
 */
export const outboundMessages = pgTable(
  "outbound_messages",
  {
    id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
    // 返信先 Chatwork ルーム（FK + 明示 index）。
    chatworkRoomId: text("chatwork_room_id")
      .notNull()
      .references(() => chatworkRooms.chatworkRoomId),
    // 返信元となった転送メッセージ（traceability。FK + 明示 index）。
    // 親メッセージ削除時は null 化（ON DELETE set null）して outbound 行は残す（行削除耐性 / 監査保持）。
    sourceChatworkMessageId: bigint("source_chatwork_message_id", { mode: "bigint" }).references(
      () => chatworkMessages.id,
      { onDelete: "set null" },
    ),
    slackChannelId: text("slack_channel_id").notNull(),
    // 逆引き結果（= 返信先メッセージの slack_ts）のスナップショット。監査・将来用に保持する。
    // 冪等キーではない（冪等は下の slack_reply_ts 側）。
    slackThreadTs: text("slack_thread_ts").notNull(),
    // トリガとなったユーザー返信メッセージの ts。冪等キー（unique で Events 再送を吸収）。
    slackReplyTs: text("slack_reply_ts").notNull(),
    // 確認メッセージの ts（chat.update 対象）。投稿後に設定するため null 可。
    slackConfirmTs: text("slack_confirm_ts"),
    // 返信を書いた本人の Slack user id（作成時に記録）。送信/キャンセル操作の認可に使う（REQ-006/009）。
    slackUserId: text("slack_user_id"),
    body: text("body").notNull(),
    status: text("status").notNull().default("pending"),
    // 送信成功時の Chatwork message id。
    chatworkMessageId: text("chatwork_message_id"),
    // 失敗時の要約（識別子のみ。本文・トークン非含有 / NFR-002）。
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 冪等キー（NFR-004。Events 再送で同一 reply を二重作成しない）。
    unique("outbound_messages_channel_reply_unique").on(table.slackChannelId, table.slackReplyTs),
    // FK index（PostgreSQL は FK に自動で index を張らない / coding-rules [MUST]）。
    index("outbound_messages_room_idx").on(table.chatworkRoomId),
    index("outbound_messages_source_idx").on(table.sourceChatworkMessageId),
    // status による絞り込み（claim / 監視）の性能用。
    index("outbound_messages_status_idx").on(table.status),
    check(
      "outbound_messages_status_check",
      sql`${table.status} in ('pending','sending','sent','cancelled','failed')`,
    ),
  ],
);

/**
 * Chatwork への配送試行ログ（slack-reply design §5.2 / coding-rules [MUST] 外部送信失敗の記録）。
 *
 * 1 つの outbound に対する送信試行（成功/失敗）を追記し、配送試行を監査可能にする。
 * `http_status` は Chatwork API の HTTP ステータス（取得できなければ null。小さい整数のため integer）、
 * `error_code` は失敗時の op 名等の識別子（本文・トークン非含有 / NFR-002）。
 */
export const deliveryAttempts = pgTable(
  "delivery_attempts",
  {
    id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
    outboundMessageId: bigint("outbound_message_id", { mode: "bigint" })
      .notNull()
      .references(() => outboundMessages.id),
    result: text("result").notNull(),
    // Chatwork API の HTTP ステータス（取得できなければ null）。小さい整数のため integer で十分。
    httpStatus: integer("http_status"),
    // 失敗時のエラーコード（op 名 / Slack/Chatwork エラーコード等の識別子。本文非含有）。
    errorCode: text("error_code"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // FK index（PostgreSQL は FK に自動で index を張らない / coding-rules [MUST]）。
    index("delivery_attempts_outbound_idx").on(table.outboundMessageId),
    check("delivery_attempts_result_check", sql`${table.result} in ('success','failure')`),
  ],
);

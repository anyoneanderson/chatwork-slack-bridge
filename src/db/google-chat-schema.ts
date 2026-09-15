import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const googleChatConnections = pgTable(
  "google_chat_connections",
  {
    id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
    slot: text("slot").notNull().unique(),
    errorCode: text("error_code"),
    notificationStatus: text("notification_status").$type<"sending" | "sent" | "unknown">(),
    provider: text("provider").notNull().default("google-chat"),
    accountEmail: text("account_email").notNull(),
    spaceName: text("space_name").notNull(),
    slackChannelId: text("slack_channel_id").notNull(),
    configIdentity: text("config_identity").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    cursor: timestamp("cursor", { withTimezone: true }).notNull(),
    windowAfter: timestamp("window_after", { withTimezone: true }),
    windowBefore: timestamp("window_before", { withTimezone: true }),
    pageToken: text("page_token"),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
  },
  (t) => [check("google_chat_provider_check", sql`${t.provider} = 'google-chat'`)],
);

export const googleChatThreads = pgTable(
  "google_chat_threads",
  {
    id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
    connectionId: bigint("connection_id", { mode: "bigint" })
      .notNull()
      .references(() => googleChatConnections.id),
    threadName: text("thread_name").notNull(),
    slackChannelId: text("slack_channel_id").notNull(),
    slackRootTs: text("slack_root_ts"),
  },
  (t) => [
    unique("google_chat_thread_unique").on(t.connectionId, t.threadName),
    index("google_chat_thread_connection_idx").on(t.connectionId),
    unique("google_chat_thread_slack_unique").on(t.slackChannelId, t.slackRootTs),
  ],
);

export const googleChatInbox = pgTable(
  "google_chat_inbox",
  {
    id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
    connectionId: bigint("connection_id", { mode: "bigint" })
      .notNull()
      .references(() => googleChatConnections.id),
    threadId: bigint("thread_id", { mode: "bigint" })
      .notNull()
      .references(() => googleChatThreads.id),
    messageName: text("message_name").notNull(),
    body: text("body").notNull(),
    senderName: text("sender_name").notNull(),
    createTime: timestamp("create_time", { withTimezone: true }).notNull(),
    status: text("status")
      .$type<"pending" | "sending" | "sent" | "unknown" | "suppressed">()
      .notNull()
      .default("pending"),
    slackTs: text("slack_ts"),
    errorCode: text("error_code"),
  },
  (t) => [
    unique("google_chat_inbox_name_unique").on(t.connectionId, t.messageName),
    index("google_chat_inbox_connection_idx").on(t.connectionId),
    index("google_chat_inbox_thread_idx").on(t.threadId),
    check(
      "google_chat_inbox_status_check",
      sql`${t.status} in ('pending','sending','sent','unknown','suppressed')`,
    ),
  ],
);

export const googleChatOutbox = pgTable(
  "google_chat_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: bigint("connection_id", { mode: "bigint" })
      .notNull()
      .references(() => googleChatConnections.id),
    threadId: bigint("thread_id", { mode: "bigint" })
      .notNull()
      .references(() => googleChatThreads.id),
    threadName: text("thread_name").notNull(),
    slackChannelId: text("slack_channel_id").notNull(),
    slackRootTs: text("slack_root_ts").notNull(),
    slackReplyTs: text("slack_reply_ts").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    slackConfirmTs: text("slack_confirm_ts"),
    body: text("body").notNull(),
    messageId: text("message_id").notNull().unique(),
    requestId: uuid("request_id").notNull().unique(),
    googleMessageName: text("google_message_name"),
    status: text("status")
      .$type<"pending" | "sending" | "sent" | "unknown" | "cancelled">()
      .notNull()
      .default("pending"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("google_chat_outbox_reply_unique").on(t.slackChannelId, t.slackReplyTs),
    index("google_chat_outbox_connection_idx").on(t.connectionId),
    index("google_chat_outbox_thread_idx").on(t.threadId),
    check(
      "google_chat_outbox_status_check",
      sql`${t.status} in ('pending','sending','sent','unknown','cancelled')`,
    ),
  ],
);

export const googleChatDeliveryAttempts = pgTable(
  "google_chat_delivery_attempts",
  {
    id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
    inboxId: bigint("inbox_id", { mode: "bigint" }).references(() => googleChatInbox.id),
    outboxId: uuid("outbox_id").references(() => googleChatOutbox.id),
    operation: text("operation").notNull(),
    result: text("result").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("google_chat_attempt_inbox_idx").on(t.inboxId),
    index("google_chat_attempt_outbox_idx").on(t.outboxId),
    check("google_chat_attempt_owner_check", sql`num_nonnulls(${t.inboxId}, ${t.outboxId}) = 1`),
  ],
);

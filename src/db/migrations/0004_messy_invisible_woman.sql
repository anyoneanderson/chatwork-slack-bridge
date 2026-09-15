CREATE TABLE "google_chat_connections" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "google_chat_connections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"slot" text NOT NULL,
	"provider" text DEFAULT 'google-chat' NOT NULL,
	"account_email" text NOT NULL,
	"space_name" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"config_identity" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cursor" timestamp with time zone NOT NULL,
	"window_after" timestamp with time zone,
	"window_before" timestamp with time zone,
	"page_token" text,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	CONSTRAINT "google_chat_connections_slot_unique" UNIQUE("slot"),
	CONSTRAINT "google_chat_provider_check" CHECK ("google_chat_connections"."provider" = 'google-chat')
);
--> statement-breakpoint
CREATE TABLE "google_chat_delivery_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "google_chat_delivery_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"inbox_id" bigint,
	"outbox_id" uuid,
	"operation" text NOT NULL,
	"result" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_chat_attempt_owner_check" CHECK (num_nonnulls("google_chat_delivery_attempts"."inbox_id", "google_chat_delivery_attempts"."outbox_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "google_chat_inbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "google_chat_inbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"connection_id" bigint NOT NULL,
	"thread_id" bigint NOT NULL,
	"message_name" text NOT NULL,
	"body" text NOT NULL,
	"sender_name" text NOT NULL,
	"create_time" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"slack_ts" text,
	"error_code" text,
	CONSTRAINT "google_chat_inbox_name_unique" UNIQUE("connection_id","message_name"),
	CONSTRAINT "google_chat_inbox_status_check" CHECK ("google_chat_inbox"."status" in ('pending','sending','sent','unknown','suppressed'))
);
--> statement-breakpoint
CREATE TABLE "google_chat_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" bigint NOT NULL,
	"thread_id" bigint NOT NULL,
	"thread_name" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"slack_root_ts" text NOT NULL,
	"slack_reply_ts" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"slack_confirm_ts" text,
	"body" text NOT NULL,
	"message_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"google_message_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_chat_outbox_message_id_unique" UNIQUE("message_id"),
	CONSTRAINT "google_chat_outbox_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "google_chat_outbox_reply_unique" UNIQUE("slack_channel_id","slack_reply_ts"),
	CONSTRAINT "google_chat_outbox_status_check" CHECK ("google_chat_outbox"."status" in ('pending','sending','sent','unknown','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "google_chat_threads" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "google_chat_threads_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"connection_id" bigint NOT NULL,
	"thread_name" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"slack_root_ts" text,
	CONSTRAINT "google_chat_thread_unique" UNIQUE("connection_id","thread_name"),
	CONSTRAINT "google_chat_thread_slack_unique" UNIQUE("slack_channel_id","slack_root_ts")
);
--> statement-breakpoint
ALTER TABLE "google_chat_delivery_attempts" ADD CONSTRAINT "google_chat_delivery_attempts_inbox_id_google_chat_inbox_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."google_chat_inbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_chat_delivery_attempts" ADD CONSTRAINT "google_chat_delivery_attempts_outbox_id_google_chat_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."google_chat_outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_chat_inbox" ADD CONSTRAINT "google_chat_inbox_connection_id_google_chat_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_chat_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_chat_inbox" ADD CONSTRAINT "google_chat_inbox_thread_id_google_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."google_chat_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_chat_outbox" ADD CONSTRAINT "google_chat_outbox_connection_id_google_chat_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_chat_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_chat_outbox" ADD CONSTRAINT "google_chat_outbox_thread_id_google_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."google_chat_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_chat_threads" ADD CONSTRAINT "google_chat_threads_connection_id_google_chat_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_chat_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "google_chat_attempt_inbox_idx" ON "google_chat_delivery_attempts" USING btree ("inbox_id");--> statement-breakpoint
CREATE INDEX "google_chat_attempt_outbox_idx" ON "google_chat_delivery_attempts" USING btree ("outbox_id");--> statement-breakpoint
CREATE INDEX "google_chat_inbox_connection_idx" ON "google_chat_inbox" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "google_chat_inbox_thread_idx" ON "google_chat_inbox" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "google_chat_outbox_connection_idx" ON "google_chat_outbox" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "google_chat_outbox_thread_idx" ON "google_chat_outbox" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "google_chat_thread_connection_idx" ON "google_chat_threads" USING btree ("connection_id");
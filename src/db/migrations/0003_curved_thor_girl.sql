CREATE TABLE "delivery_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "delivery_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"outbound_message_id" bigint NOT NULL,
	"result" text NOT NULL,
	"http_status" integer,
	"error_code" text,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_attempts_result_check" CHECK ("delivery_attempts"."result" in ('success','failure'))
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbound_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chatwork_room_id" text NOT NULL,
	"source_chatwork_message_id" bigint,
	"slack_channel_id" text NOT NULL,
	"slack_thread_ts" text NOT NULL,
	"slack_reply_ts" text NOT NULL,
	"slack_confirm_ts" text,
	"slack_user_id" text,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"chatwork_message_id" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_messages_channel_reply_unique" UNIQUE("slack_channel_id","slack_reply_ts"),
	CONSTRAINT "outbound_messages_status_check" CHECK ("outbound_messages"."status" in ('pending','sending','sent','cancelled','failed'))
);
--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_outbound_message_id_outbound_messages_id_fk" FOREIGN KEY ("outbound_message_id") REFERENCES "public"."outbound_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_chatwork_room_id_chatwork_rooms_chatwork_room_id_fk" FOREIGN KEY ("chatwork_room_id") REFERENCES "public"."chatwork_rooms"("chatwork_room_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_source_chatwork_message_id_chatwork_messages_id_fk" FOREIGN KEY ("source_chatwork_message_id") REFERENCES "public"."chatwork_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_attempts_outbound_idx" ON "delivery_attempts" USING btree ("outbound_message_id");--> statement-breakpoint
CREATE INDEX "outbound_messages_room_idx" ON "outbound_messages" USING btree ("chatwork_room_id");--> statement-breakpoint
CREATE INDEX "outbound_messages_source_idx" ON "outbound_messages" USING btree ("source_chatwork_message_id");--> statement-breakpoint
CREATE INDEX "outbound_messages_status_idx" ON "outbound_messages" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "chatwork_messages_slack_channel_ts_unique" ON "chatwork_messages" USING btree ("slack_channel_id","slack_ts") WHERE "chatwork_messages"."slack_channel_id" is not null and "chatwork_messages"."slack_ts" is not null;
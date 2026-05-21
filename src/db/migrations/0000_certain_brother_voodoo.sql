CREATE TABLE "chatwork_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chatwork_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chatwork_room_id" text NOT NULL,
	"chatwork_message_id" text NOT NULL,
	"chatwork_account_id" text,
	"sender_name" text,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"slack_channel_id" text,
	"slack_ts" text,
	"slack_thread_ts" text,
	"status" text DEFAULT 'open' NOT NULL,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chatwork_messages_room_message_unique" UNIQUE("chatwork_room_id","chatwork_message_id"),
	CONSTRAINT "chatwork_messages_status_check" CHECK ("chatwork_messages"."status" in ('open','done'))
);
--> statement-breakpoint
CREATE TABLE "chatwork_rooms" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chatwork_rooms_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chatwork_room_id" text NOT NULL,
	"room_name" text NOT NULL,
	"room_type" text NOT NULL,
	"slack_channel_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chatwork_rooms_chatwork_room_id_unique" UNIQUE("chatwork_room_id"),
	CONSTRAINT "chatwork_rooms_room_type_check" CHECK ("chatwork_rooms"."room_type" in ('group','direct','my'))
);
--> statement-breakpoint
ALTER TABLE "chatwork_messages" ADD CONSTRAINT "chatwork_messages_chatwork_room_id_chatwork_rooms_chatwork_room_id_fk" FOREIGN KEY ("chatwork_room_id") REFERENCES "public"."chatwork_rooms"("chatwork_room_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chatwork_messages_room_sent_at_idx" ON "chatwork_messages" USING btree ("chatwork_room_id","sent_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chatwork_messages_status_idx" ON "chatwork_messages" USING btree ("status");
CREATE TABLE "chatwork_message_attachments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chatwork_message_attachments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chatwork_message_id" bigint NOT NULL,
	"chatwork_file_id" text NOT NULL,
	"slack_file_id" text NOT NULL,
	"slack_channel_id" text NOT NULL,
	"slack_thread_ts" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chatwork_message_attachments_message_file_unique" UNIQUE("chatwork_message_id","chatwork_file_id")
);
--> statement-breakpoint
ALTER TABLE "chatwork_message_attachments" ADD CONSTRAINT "chatwork_message_attachments_chatwork_message_id_chatwork_messages_id_fk" FOREIGN KEY ("chatwork_message_id") REFERENCES "public"."chatwork_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chatwork_message_attachments_message_idx" ON "chatwork_message_attachments" USING btree ("chatwork_message_id");
CREATE TABLE "chatwork_room_members" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chatwork_room_members_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chatwork_room_id" text NOT NULL,
	"chatwork_account_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chatwork_room_members_room_account_unique" UNIQUE("chatwork_room_id","chatwork_account_id")
);
--> statement-breakpoint
ALTER TABLE "chatwork_room_members" ADD CONSTRAINT "chatwork_room_members_chatwork_room_id_chatwork_rooms_chatwork_room_id_fk" FOREIGN KEY ("chatwork_room_id") REFERENCES "public"."chatwork_rooms"("chatwork_room_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chatwork_room_members_room_idx" ON "chatwork_room_members" USING btree ("chatwork_room_id");
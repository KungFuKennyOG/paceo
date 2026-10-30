CREATE TABLE "activity_streams" (
	"activity_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"format" integer NOT NULL,
	"laps" jsonb NOT NULL,
	"laps_source" text,
	"samples" "bytea",
	"sample_count" integer DEFAULT 0 NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"user_id" uuid NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "proposals_user_id_id_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "activity_streams" ADD CONSTRAINT "activity_streams_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_streams" ADD CONSTRAINT "activity_streams_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_streams_user_idx" ON "activity_streams" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "proposals_user_status_idx" ON "proposals" USING btree ("user_id","status");

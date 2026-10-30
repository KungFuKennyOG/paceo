CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"origin_platform" text,
	"start_utc" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"sport" text NOT NULL,
	"distance_m" double precision,
	"moving_s" double precision,
	"elapsed_s" double precision,
	"avg_hr" double precision,
	"is_race" boolean DEFAULT false NOT NULL,
	"name" text,
	"device" text,
	"garmin_origin" boolean DEFAULT false NOT NULL,
	"strava_derived" boolean DEFAULT false NOT NULL,
	"duplicate_of" uuid,
	"raw_file_id" uuid,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"date" date NOT NULL,
	"workout_id" uuid,
	"activity_id" uuid,
	"payload" jsonb NOT NULL,
	"plan_changes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"secret_enc" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"athlete_ext_id" text,
	"athlete_name" text,
	"status" text NOT NULL,
	"status_message" text,
	"last_validated_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_seen_date" date,
	"activity_counts" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fitness_state" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"vdot" double precision,
	"vdot_source" text NOT NULL,
	"vdot_date" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" uuid,
	CONSTRAINT "invites_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "planned_workouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid,
	"engine_id" text NOT NULL,
	"date" date NOT NULL,
	"sport" text NOT NULL,
	"type" text NOT NULL,
	"content_hash" text NOT NULL,
	"workout" jsonb NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"skip_reason" text,
	"rule_trace" jsonb NOT NULL,
	"sink_state" jsonb NOT NULL,
	"rev" integer DEFAULT 0 NOT NULL,
	"device_text" text,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"input" jsonb NOT NULL,
	"plan" jsonb NOT NULL,
	"paces" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "raw_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"bytes" "bytea" NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "screening" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"outcome" text NOT NULL,
	"can_proceed" boolean NOT NULL,
	"answers" jsonb NOT NULL,
	"notes" jsonb NOT NULL,
	"screened_at" timestamp with time zone NOT NULL,
	"clearance_confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profile" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"profile" jsonb NOT NULL,
	"units" text NOT NULL,
	"timezone" text NOT NULL,
	"goal_type" text NOT NULL,
	"race_date" date,
	"watch_brand" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_raw_file_id_raw_files_id_fk" FOREIGN KEY ("raw_file_id") REFERENCES "public"."raw_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_workout_id_planned_workouts_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."planned_workouts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fitness_state" ADD CONSTRAINT "fitness_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_workouts" ADD CONSTRAINT "planned_workouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_workouts" ADD CONSTRAINT "planned_workouts_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_files" ADD CONSTRAINT "raw_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening" ADD CONSTRAINT "screening_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activities_dedup_uq" ON "activities" USING btree ("user_id","source","source_id");--> statement-breakpoint
CREATE INDEX "activities_user_date_idx" ON "activities" USING btree ("user_id","local_date");--> statement-breakpoint
CREATE INDEX "activities_user_start_idx" ON "activities" USING btree ("user_id","start_utc");--> statement-breakpoint
CREATE INDEX "checkins_user_date_idx" ON "checkins" USING btree ("user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_user_provider_uq" ON "credentials" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "planned_workouts_user_date_idx" ON "planned_workouts" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "planned_workouts_removed_idx" ON "planned_workouts" USING btree ("user_id") WHERE "planned_workouts"."removed_at" is not null;--> statement-breakpoint
CREATE INDEX "plans_user_created_idx" ON "plans" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_files_user_sha_uq" ON "raw_files" USING btree ("user_id","sha256");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");
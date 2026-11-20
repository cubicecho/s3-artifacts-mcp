CREATE TYPE "bucket_provider" AS ENUM('s3', 'minio', 'rustfs', 'b2');--> statement-breakpoint
CREATE TABLE "buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"provider" "bucket_provider" NOT NULL,
	"endpoint" text,
	"public_endpoint" text,
	"region" text NOT NULL,
	"bucket" text NOT NULL,
	"access_key_id" text NOT NULL,
	"secret_access_key_enc" text NOT NULL,
	"force_path_style" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"mcp_enabled" boolean DEFAULT false NOT NULL,
	"mcp_writable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_buckets_slug" ON "buckets" ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_buckets_default" ON "buckets" ("user_id") WHERE "is_default";--> statement-breakpoint
CREATE INDEX "idx_buckets_user_id" ON "buckets" ("user_id");--> statement-breakpoint
ALTER TABLE "buckets" ADD CONSTRAINT "buckets_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
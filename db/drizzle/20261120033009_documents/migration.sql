CREATE TYPE "document_status" AS ENUM('pending_upload', 'ready');--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"bucket_id" uuid NOT NULL,
	"title" text NOT NULL,
	"filename" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text,
	"status" "document_status" DEFAULT 'pending_upload'::"document_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_documents_user_id" ON "documents" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_documents_bucket_id_status" ON "documents" ("bucket_id","status");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_bucket_id_buckets_id_fkey" FOREIGN KEY ("bucket_id") REFERENCES "buckets"("id") ON DELETE RESTRICT;
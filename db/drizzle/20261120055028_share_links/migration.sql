CREATE TYPE "share_link_creator" AS ENUM('owner', 'mcp');--> statement-breakpoint
CREATE TYPE "share_link_permission" AS ENUM('view', 'download');--> statement-breakpoint
CREATE TABLE "app_settings" (
	"user_id" uuid PRIMARY KEY,
	"max_upload_bytes" bigint DEFAULT 104857600 NOT NULL,
	"default_link_expiry_hours" integer DEFAULT 24 NOT NULL,
	"default_link_permission" "share_link_permission" DEFAULT 'download'::"share_link_permission" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"label" text,
	"permission" "share_link_permission" NOT NULL,
	"url_enc" text NOT NULL,
	"object_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" "share_link_creator" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_share_links_user_id" ON "share_links" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_share_links_document_id" ON "share_links" ("document_id");--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_document_id_documents_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE;
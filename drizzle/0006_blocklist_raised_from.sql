ALTER TABLE "hash_blocklist" ADD COLUMN "raised_from" "blocklist_reason";--> statement-breakpoint
ALTER TABLE "hash_blocklist" ADD COLUMN "raised_by_node_id" uuid;
ALTER TABLE "uploads" ADD COLUMN "ip_encrypted" "bytea";--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "ip_iv" "bytea";--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "ip_key_version" smallint;
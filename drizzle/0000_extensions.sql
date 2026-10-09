-- Extensions the schema needs, before any table: `citext` columns and the `gin_trgm_ops` index
-- of migration 0001 do not exist without them. Hand-written (drizzle-kit generate --custom).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;

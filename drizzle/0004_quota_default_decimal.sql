ALTER TABLE "user" ALTER COLUMN "quota_bytes" SET DEFAULT 5000000000;--> statement-breakpoint
-- Hand-written from here (a default applies to new rows only; drizzle-kit generates no data statement).
--
-- The quota is decimal now: 5,000,000,000 bytes ("5 GB"), not 5 GiB (5,368,709,120). A row that
-- still holds exactly the old default was never given a quota of its own, so it takes the new one.
-- Any other value (an operator's grant, a test row) is left alone. `used_bytes` is not touched: an
-- account already holding more than 5,000,000,000 bytes keeps its files and cannot add to them.
UPDATE "user" SET "quota_bytes" = 5000000000 WHERE "quota_bytes" = 5368709120;

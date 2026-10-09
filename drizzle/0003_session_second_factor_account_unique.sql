ALTER TABLE "session" ADD COLUMN "second_factor_at" timestamp;--> statement-breakpoint
-- Hand-written from here (the generated auth schema cannot declare this index: auth-schema.ts
-- must stay exactly what `npm run auth:generate` writes).
--
-- One provider identity belongs to at most one `account` row. Better Auth checks "is this Google
-- identity linked yet?" and inserts in two separate statements, so two simultaneous first
-- sign-ins could link the same identity twice.
--
-- FAILS LOUDLY, CHANGES NOTHING, when the database already holds such a pair: the migration runs
-- in one transaction, so the column above is rolled back with it. Nothing is deleted here — which
-- of two rows is the real one is a decision for a person. Read-only pre-check:
--   SELECT provider_id, count(*) FROM (SELECT provider_id, account_id FROM account
--     GROUP BY 1, 2 HAVING count(*) > 1) d GROUP BY 1;
DO $$
DECLARE
  duplicates integer;
BEGIN
  SELECT count(*) INTO duplicates
  FROM (SELECT 1 FROM "account" GROUP BY "provider_id", "account_id" HAVING count(*) > 1) AS d;
  IF duplicates > 0 THEN
    RAISE EXCEPTION 'migration 0003 refused: % provider identit(ies) are linked more than once in "account" (provider_id, account_id). Nothing was changed. Resolve the duplicate rows by hand, then migrate again.', duplicates;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_uidx" ON "account" USING btree ("provider_id","account_id");

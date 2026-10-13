-- Hand-written (drizzle-kit generate --custom): no table changes. JIT compilation is off for every
-- NEW session of this database, whatever role opens it.
--
-- Why: the listings and the search test every row against its ancestors (a per-row SubPlan,
-- `notEffectivelyTrashedOrHidden`), which the planner prices far above `jit_above_cost` (100,000)
-- and the inlining / optimisation thresholds (500,000) once a tree has grown. On a server built
-- with LLVM each such statement is then compiled before it runs: measured on 50,000 nodes, about
-- 170–220 ms of compilation in front of 12–21 ms of work. These are short index reads; JIT pays
-- for itself only on long analytic scans, which this application does not run.
--
-- Where it matters: on a server that HAS JIT — the local and CI Postgres (the stock image ships
-- llvmjit). The hosted database (Neon) appears to be built without LLVM, in which case nothing
-- was ever compiled there and this changes no timing in production: it makes the local and CI
-- databases behave like it, and keeps them alike should the host ever ship JIT. `jit` is an
-- ordinary setting on every build (only the provider library is optional), so the statement is
-- accepted on a server without JIT too, and stores a value that has nothing to switch off.
--
-- Stored on the DATABASE, not set per session: the Worker's connections come through a
-- transaction pooler (Hyperdrive), which keeps no session state. Postgres applies a stored
-- setting itself, when a backend starts — so sessions that were already open keep their value
-- until the pooler recycles them. A setting stored on a ROLE would override this one.
--
-- The name is not written down: every environment's database is called something else.
--
-- Only the database's owner (or a superuser) may store a setting on it, and there is deliberately
-- no exception handler: a migration that quietly did nothing would leave that database compiling
-- and the deploy green. If it fails with "must be owner of database", the owner runs
-- `ALTER DATABASE <name> SET jit = off;` by hand and the deploy is run again — which is why the
-- statement is skipped when exactly that is already stored (for every role, on this database):
-- the migrating role could otherwise never get past this file. Running it again changes nothing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
    WHERE d.datname = current_database() AND s.setrole = 0 AND 'jit=off' = ANY (s.setconfig)
  ) THEN
    EXECUTE format('ALTER DATABASE %I SET jit = off', current_database());
  END IF;
END
$$;

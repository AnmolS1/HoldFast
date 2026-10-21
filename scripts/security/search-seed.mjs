// Seeds many tenants for the search measurement (T26 item 18) — the local proxy for the shared
// side of `searchNames` over a whole table of other people's names, and the seeding of the dev
// Neon branch for the post-integration EXPLAIN.
//
//   DATABASE_URL_DIRECT=… npx tsx scripts/security/search-seed.mjs [--grantee <user id>] \
//       [--tenants 200] [--files 1000] [--shared-owners 20] [--non-prod-host <db host>]
//   DATABASE_URL_DIRECT=… npx tsx scripts/security/search-seed.mjs --cleanup <tag> [--non-prod-host …]
//
// Each tenant is a made-up account (it never signs in) with one top folder, ten sub-folders named
// "Invoices <n>" and `--files` files: one in 5000 is named "zephyrine-…" (the RARE term), one in
// three "report-…" (the COMMON term), the rest "file-…". The grantee — `--grantee`, or a made-up
// account created here — holds an activated viewer share on the top folder of the first
// `--shared-owners` tenants; the others share nothing with it, so their matches are what a
// whole-table match set wastes. Ends with ANALYZE nodes, shares. Prints the tag, the grantee id
// and the three terms; never a connection string.

import { parseArgs } from "node:util";
import pg from "pg";
import { classifyTarget } from "../lib/session-target.ts";

const { values } = parseArgs({
  options: {
    grantee: { type: "string" },
    tenants: { type: "string", default: "200" },
    files: { type: "string", default: "1000" },
    "shared-owners": { type: "string", default: "20" },
    cleanup: { type: "string" },
    "non-prod-host": { type: "string" },
  },
});
const target = classifyTarget(process.env.DATABASE_URL_DIRECT, { nonProdHost: values["non-prod-host"] });
if (target.target === "prod") {
  console.error("search-seed: never against production");
  process.exit(2);
}
const db = new pg.Client({ connectionString: target.url });
await db.connect();

const EMAIL = (tag) => `remote-spec-search-${tag}-%@holdfast-search.example`;

try {
  if (values.cleanup) {
    const tag = values.cleanup;
    if (!/^[a-z0-9]{6,16}$/.test(tag)) throw new Error("--cleanup takes the tag the seed printed");
    await db.query("BEGIN");
    const owners = `SELECT id FROM "user" WHERE email LIKE $1`;
    await db.query(
      `DELETE FROM shares WHERE node_id IN (SELECT id FROM nodes WHERE owner_id IN (${owners}))`,
      [EMAIL(tag)],
    );
    // Children first: parent_id is NO ACTION, checked at the end of each statement.
    await db.query(`DELETE FROM nodes WHERE owner_id IN (${owners}) AND kind = 'file'`, [EMAIL(tag)]);
    await db.query(`DELETE FROM nodes WHERE owner_id IN (${owners}) AND parent_id IS NOT NULL`, [EMAIL(tag)]);
    await db.query(`DELETE FROM nodes WHERE owner_id IN (${owners})`, [EMAIL(tag)]);
    const gone = await db.query(`DELETE FROM "user" WHERE email LIKE $1`, [EMAIL(tag)]);
    await db.query("COMMIT");
    console.log(`search-seed: removed ${gone.rowCount} seeded account(s) of tag ${tag} and their trees`);
  } else {
    const tenants = Number(values.tenants);
    const files = Number(values.files);
    const sharedOwners = Math.min(Number(values["shared-owners"]), tenants);
    const tag = Array.from(
      crypto.getRandomValues(new Uint8Array(8)),
      (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36],
    ).join("");
    await db.query("BEGIN");
    // The accounts: made up, verified, never signed in.
    await db.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       SELECT 'srch' || $1 || lpad(g::text, 20, '0'), 'Search Tenant ' || g,
              'remote-spec-search-' || $1 || '-' || g || '@holdfast-search.example', true, now(), now()
       FROM generate_series(1, $2::int) g`,
      [tag, tenants],
    );
    let grantee = values.grantee;
    if (!grantee) {
      grantee = `srch${tag}grantee000000000000`.slice(0, 32);
      await db.query(
        `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
         VALUES ($1, 'Search Grantee', $2, true, now(), now())`,
        [grantee, `remote-spec-search-${tag}-grantee@holdfast-search.example`],
      );
    }
    const owner = `'srch' || $1 || lpad(g::text, 20, '0')`;
    await db.query(
      `INSERT INTO nodes (id, owner_id, created_by, kind, name, name_key, scan_status)
       SELECT gen_random_uuid(), ${owner}, ${owner}, 'folder', 'Shared ' || $1 || ' ' || g, lower('Shared ' || $1 || ' ' || g), 'clean'
       FROM generate_series(1, $2::int) g`,
      [tag, tenants],
    );
    await db.query(
      `INSERT INTO nodes (id, owner_id, created_by, parent_id, kind, name, name_key, scan_status)
       SELECT gen_random_uuid(), top.owner_id, top.owner_id, top.id, 'folder', 'Invoices ' || k, 'invoices ' || k, 'clean'
       FROM nodes top CROSS JOIN generate_series(1, 10) k
       WHERE top.parent_id IS NULL AND top.name LIKE 'Shared ' || $1 || ' %'`,
      [tag],
    );
    await db.query(
      `INSERT INTO nodes (id, owner_id, created_by, parent_id, kind, name, name_key, ext, size, scan_status)
       SELECT gen_random_uuid(), sub.owner_id, sub.owner_id, sub.id, 'file', f.name, lower(f.name), f.ext, 1000, 'clean'
       FROM nodes sub JOIN nodes top ON top.id = sub.parent_id
       CROSS JOIN LATERAL (
         -- i: unique over the whole seed (tenant g, sub-folder k, file j).
         SELECT CASE WHEN i % 5000 = 7 THEN 'zephyrine-' || i || '.txt'
                     WHEN i % 3 = 0 THEN 'report-' || i || '.pdf'
                     ELSE 'file-' || i || '.bin' END AS name,
                CASE WHEN i % 5000 = 7 THEN 'txt' WHEN i % 3 = 0 THEN 'pdf' ELSE 'bin' END AS ext
         FROM (
           SELECT ((split_part(top.name, ' ', 3)::int - 1) * $2::int
                   + (split_part(sub.name, ' ', 2)::int - 1) * ($2::int / 10) + j) AS i
           FROM generate_series(1, $2::int / 10) j
         ) numbered
       ) f
       WHERE top.name LIKE 'Shared ' || $1 || ' %'`,
      [tag, files],
    );
    await db.query(
      `INSERT INTO shares (id, node_id, granted_by, grantee_email, grantee_user_id, activated_at, role)
       SELECT gen_random_uuid(), top.id, top.owner_id, 'grantee-' || $1 || '@holdfast-search.example', $2, now(), 'viewer'
       FROM nodes top
       WHERE top.parent_id IS NULL AND top.name LIKE 'Shared ' || $1 || ' %'
         AND split_part(top.name, ' ', 3)::int <= $3::int`,
      [tag, grantee, sharedOwners],
    );
    await db.query("COMMIT");
    await db.query("ANALYZE nodes");
    await db.query("ANALYZE shares");
    const counts = await db.query(
      `SELECT count(*) FILTER (WHERE kind = 'file')::int AS files, count(*) FILTER (WHERE kind = 'folder')::int AS folders,
              count(*) FILTER (WHERE name LIKE 'zephyrine-%')::int AS rare, count(*) FILTER (WHERE name LIKE 'report-%')::int AS common
       FROM nodes WHERE owner_id LIKE 'srch' || $1 || '%'`,
      [tag],
    );
    const c = counts.rows[0];
    console.log(
      `search-seed (${target.target}): tag ${tag}; ${tenants} tenants, ${c.folders} folders, ${c.files} files ` +
        `(${c.rare} rare, ${c.common} common); the grantee shares ${sharedOwners} of them`,
    );
    console.log(`  grantee: ${grantee}`);
    console.log(`  terms:   --term zephyrine --term report --term invoices`);
    console.log(`  cleanup: search-seed.mjs --cleanup ${tag}`);
  }
} catch (error) {
  await db.query("ROLLBACK").catch(() => undefined);
  console.error(`search-seed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await db.end();
}

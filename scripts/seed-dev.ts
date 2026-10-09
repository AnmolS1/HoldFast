// Seeds a LOCAL development database: three invite codes, the default settings and a small
// sample folder tree. Idempotent — run it as often as you like; it never overwrites a setting.
//
//   npx tsx scripts/seed-dev.ts
//   npx tsx scripts/seed-dev.ts --owner you@example.com     # give the sample tree to that account
//
// The database is the one `DATABASE_URL_DIRECT` names, read from the process environment only
// (never from .dev.vars or .env). Without it, the local database of this checkout is used:
// `HOLDFAST_DB` (default `holdfast`) on localhost. A database that is not on localhost is
// refused. The admin account is not created here: sign in with an `ADMIN_EMAILS` address.

import { parseArgs } from "node:util";
import { and, eq, isNull, sql } from "drizzle-orm";
import { type Db, withDb } from "../src/worker/db/client";
import { invites, nodes, settings, user } from "../src/worker/db/schema";
import { nameKeyOf } from "../src/worker/services/filename";
import { redactText } from "../src/shared/sentry-redact";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function localUrl(): { url: string; database: string } {
  const name = process.env.HOLDFAST_DB || "holdfast";
  if (!/^holdfast(_[a-z0-9_]+)?$/.test(name))
    throw new Error("HOLDFAST_DB must be 'holdfast' or 'holdfast_<name>'");
  const raw = process.env.DATABASE_URL_DIRECT || `postgres://postgres:postgres@localhost:5432/${name}`;
  const url = new URL(raw);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`refusing to seed: the database host is '${url.hostname}', not localhost`);
  }
  return { url: url.toString(), database: url.pathname.slice(1) };
}

const INVITES = [
  { code: "DEV-INVITE-ALPHA", note: "dev seed 1" },
  { code: "DEV-INVITE-BRAVO", note: "dev seed 2" },
  { code: "DEV-INVITE-CHARLIE", note: "dev seed 3" },
];

/** A placeholder account that owns the sample tree when no `--owner` is given. It cannot sign in. */
const SEED_USER = {
  id: "devseed0000000000000000000000000",
  email: "dev-seed@holdfast.invalid",
  name: "Dev Seed",
};

const TREE: { path: string[] }[] = [
  { path: ["Documents"] },
  { path: ["Documents", "Reports"] },
  { path: ["Documents", "Reports", "2026"] },
  { path: ["Photos"] },
  { path: ["Photos", "Holidays"] },
  { path: ["Projects"] },
  { path: ["Projects", "Holdfast"] },
];

async function seedInvites(db: Db): Promise<number> {
  const rows = await db
    .insert(invites)
    .values(INVITES.map((invite) => ({ ...invite, maxUses: 100 })))
    .onConflictDoNothing()
    .returning({ code: invites.code });
  return rows.length;
}

async function seedSettings(db: Db): Promise<number> {
  const signupMode = process.env.SIGNUP_MODE === "open" ? "open" : "invite";
  const defaults: Record<string, unknown> = {
    signupMode,
    uploadsEnabled: true,
    linksEnabled: true,
    readOnly: false,
    orphanDeleteEnabled: true,
    termsVersion: process.env.TERMS_VERSION || "dev",
  };
  let written = 0;
  for (const [key, value] of Object.entries(defaults)) {
    const rows = await db
      .insert(settings)
      .values({ key, value: sql`${JSON.stringify(value)}::jsonb` })
      .onConflictDoNothing()
      .returning({ key: settings.key });
    written += rows.length;
  }
  return written;
}

async function ownerId(db: Db, email: string | undefined): Promise<string> {
  if (email) {
    const [row] = await db
      .select({ id: user.id })
      .from(user)
      .where(sql`lower(${user.email}) = ${email.toLowerCase()}`);
    if (!row) throw new Error("no account has that email address; sign up first, then run the seed again");
    return row.id;
  }
  await db
    .insert(user)
    .values({ ...SEED_USER, emailVerified: false })
    .onConflictDoNothing();
  return SEED_USER.id;
}

async function seedTree(db: Db, owner: string): Promise<number> {
  let created = 0;
  const ids = new Map<string, string>();
  for (const { path } of TREE) {
    const name = path[path.length - 1]!;
    const parentId = path.length > 1 ? ids.get(path.slice(0, -1).join("/"))! : null;
    const [existing] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, owner),
          parentId === null ? isNull(nodes.parentId) : eq(nodes.parentId, parentId),
          eq(nodes.nameKey, nameKeyOf(name)),
          isNull(nodes.deletedAt),
          isNull(nodes.system),
        ),
      );
    if (existing) {
      ids.set(path.join("/"), existing.id);
      continue;
    }
    const [row] = await db
      .insert(nodes)
      .values({
        ownerId: owner,
        createdBy: owner,
        parentId,
        kind: "folder",
        name,
        nameKey: nameKeyOf(name),
        scanStatus: "clean",
      })
      .returning({ id: nodes.id });
    ids.set(path.join("/"), row!.id);
    created++;
  }
  return created;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { owner: { type: "string" } }, strict: true });
  const { url, database } = localUrl();
  const env = { HYPERDRIVE: { connectionString: url } } as Env;
  const result = await withDb(env, async (db) => {
    const invitesCreated = await seedInvites(db);
    const settingsCreated = await seedSettings(db);
    const foldersCreated = await seedTree(db, await ownerId(db, values.owner));
    return { invitesCreated, settingsCreated, foldersCreated };
  });
  console.log(
    `seed-dev: database ${database} — ${result.invitesCreated} invite(s), ${result.settingsCreated} setting(s), ` +
      `${result.foldersCreated} folder(s) created (existing ones were left as they are)`,
  );
  console.log(`seed-dev: invite codes: ${INVITES.map((i) => i.code).join(", ")}`);
}

main().catch((error: unknown) => {
  console.error(`seed-dev: ${error instanceof Error ? redactText(error.message) : "failed"}`);
  process.exitCode = 1;
});

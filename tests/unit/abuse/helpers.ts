// Shared by the abuse tests (T22). Runs inside workerd, against this checkout's local Postgres.
//
// Postgres is shared by every test file and every run: fixtures have random ids, nothing counts a
// whole table, settings are passed in. The operators of a test are a fresh made-up address (the
// mail ledger is shared too, so the one ADMIN_EMAIL would reach its hourly count across runs).
import { and, eq, sql } from "drizzle-orm";
import { reports, shareLinks, type ScanStatus } from "../../../src/worker/db/schema";
import {
  api,
  asCaller,
  makeFile,
  makeFolder,
  member,
  rand,
  testDb,
  type ApiOptions,
} from "../sharing/helpers";
import { linkTo } from "../sharing/public-helpers";
import { mailTo } from "../auth/helpers";

export type Member = Awaited<ReturnType<typeof member>>;

/** A made-up operator mailbox of one test, and the env override that makes it the only one. */
export function operators() {
  const address = `ops-${rand(6)}@example.test`;
  return { address, env: { ADMIN_EMAILS: address, E2E_ADMIN_EMAILS: "" } };
}

/**
 * A made-up client address (documentation range 2001:db8::/32, never routed) in a /64 of its own:
 * each is a reporter of its own, also against the reports earlier runs left in the shared
 * database (the per-reporter cap counts 24 hours of them).
 */
export const freshIp = () => `2001:db8:${rand(2)}:${rand(2)}::1`;

export type ReportJson = {
  nodeId: string;
  linkToken?: string;
  category?: string;
  details?: string;
  reporterEmail?: string;
  turnstileToken?: string;
};

const body = (json: ReportJson) => ({
  category: "spam",
  details: "",
  turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
  ...json,
});

/** `POST /api/public/report` with no session. */
export function publicReport(json: ReportJson, options: ApiOptions = {}) {
  return api(null, "/public/report", { ip: freshIp(), ...options, json: body(json) });
}

/** `POST /api/reports` as `user`. */
export function sessionReport(user: Member, json: ReportJson, options: ApiOptions = {}) {
  return api(asCaller(user as never), "/reports", { ip: freshIp(), ...options, json: body(json) });
}

/** A file under a folder under a folder, and a link on the outer folder — the file two levels down. */
export async function deepLink(scanStatus: ScanStatus = "clean") {
  const owner = await member();
  const outer = await makeFolder(owner.id);
  const inner = await makeFolder(owner.id, outer.id);
  const file = await makeFile(owner.id, inner.id, { scanStatus, name: `doc-${rand()}.txt`, size: 10 });
  const link = await linkTo(owner, outer.id);
  return { owner, outer, inner, file, link };
}

export async function reportsOn(nodeId: string) {
  return testDb().select().from(reports).where(eq(reports.nodeId, nodeId)).orderBy(reports.createdAt);
}

export async function linkRow(id: string) {
  const [row] = await testDb().select().from(shareLinks).where(eq(shareLinks.id, id));
  return row!;
}

/** Every routine "an item for review" mail to `address` that names `id`. */
export function alertsAbout(address: string, id: string) {
  return mailTo(address).filter((m) => String(m.text ?? "").includes(id));
}

/** Moves one report's filing time back by `hours` (fixture rows only — never the clock). */
export async function backdateReport(id: string, hours: number) {
  await testDb()
    .update(reports)
    .set({ createdAt: sql`${reports.createdAt} - make_interval(hours => ${hours})` })
    .where(eq(reports.id, id));
}

export async function reportsBy(nodeId: string, category: string) {
  return testDb()
    .select()
    .from(reports)
    .where(and(eq(reports.nodeId, nodeId), sql`${reports.category} = ${category}`));
}

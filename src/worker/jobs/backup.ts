// The nightly logical export (T27; cron `0 2 * * *`, FIRST in its slot — before user-purge and
// reconcile, so that night's purges are still in that night's export). Metadata only: no file
// bytes. Primary recovery is Neon's point-in-time restore; this is the second copy.
//
//   b/db/<YYYY-MM-DD UTC>/<table>.jsonl.gz       every table of the schema, one JSON row per line
//   b/db/<date>/_attempt.json                    the pass now writing the set: { attempt, startedAt }
//   b/db/<date>/_progress/<table>.json           a table this attempt finished (for T25's progress)
//   b/db/<date>/_manifest.json                   written LAST, read back and checked: the set is whole
//
// KEYS STAY UNDER `b/db/` — never `u/`, `t/` or `a/` (spike S8: every write under `u/` is a scan
// message; reconcile's orphan sweep deletes unreferenced objects there after 48 h). No key here is
// built from storage.ts's `keyFor`.
//
// WRITES ARE MULTIPART (spike P4): `put()` refuses a stream of unknown length, and gzip output has
// none. Compressed bytes are cut into parts of exactly BACKUP_PART_BYTES (`PartChunker`) — every
// non-final part that size, the last whatever remains; a table smaller than one part is one `put`
// of its buffered bytes. A part-size mistake would surface only at `complete()`, which is why the
// chunker has its own test. On any failure the table's multipart upload is ABORTED — the one
// object removal this job makes, exempt from PLAN §6 rule 17 (brief R-5): an unfinished `b/db/`
// upload holds no user data and no restorable set. A COMPLETE set is never touched: a date whose
// manifest exists is not written again, and expiry is the bucket's 35-day lifecycle rule.
//
// ONE SNAPSHOT PER SET (brief Addendum 3, M1 — replaces the earlier resume-by-table). Every row of
// a set comes from ONE snapshot: the pass reads every page of every table inside a single
// `REPEATABLE READ, READ ONLY` transaction, so no move, purge or insert during the pass can put two
// moments into the set (a cycle between two pages of `nodes`, a live subtree under a parent purged
// in between). That transaction holds one pooled connection for the whole pass — behind Hyperdrive
// one backend, beside the lock's own (two of a Worker's six) — and sets its own limits: one
// statement at most SNAPSHOT_STATEMENT_MS, idle between statements (an 8 MiB part going up) at most
// SNAPSHOT_IDLE_MS; the pass itself is bounded by its soft deadline (600 s from the cron slot,
// jobs/index.ts; 20 s or 540 s streamed from T25's call), looked at between pages on `clock`.
// A pass that does not finish leaves NO manifest; the next pass for that date is a new attempt in a
// new snapshot and writes every table again over what the dead one left (keys are fixed by the
// task; `_attempt.json` and each progress record name the attempt). So a large database needs ONE
// call long enough for all of it — the cron slot or T25's streamed call.
//
// NO LIVE CREDENTIALS WITHOUT RECOVERY VALUE (M4): `EMPTIED_TABLES` (session, verification) leave
// with their columns and no rows; `NULLED_COLUMNS` (account's OAuth tokens) are left out. The
// manifest says so. It also records the migration level and every table's columns (M2), which the
// restore compares with its target.
//
// ONE PASS AT A TIME: under the job lock `backup` (trash-jobs.ts `withJobLock`); a second
// overlapping call answers at once, `overlap`, done: false.
//
// THE ROLLBACK DETECTOR (brief R-10). Backup destroys nothing, so it is not `guarded` and never
// stops on a rollback reading. It RECORDS one: each pass asks `readsRolledBack` (a read; fail
// closed — what cannot be read reads as rolled back), and each table's record and the manifest
// carry `detection: "ok" | "rollback"`. The restore script warns before loading a set written
// while rolled back. (`"unknown"` and `"not_read"` stay in the type for sets from elsewhere: a
// reader must not switch exhaustively over the values.)
//
// THREE ALARMS RUN IN THE TAIL OF EVERY PASS — done or not, failed or not (brief R-6), each on its own:
//   images   the month's image transformations (the `transform_user` ledger units) at or past
//            IMAGES_ALARM_UNITS (4,000 of the Free plan's 5,000/month; spike S15: no Cloudflare
//            alert can be set there) → `adminAlert` kind `images_budget`, id = the UTC date;
//   kept     accounts past the kept-bytes backstop now (quota.ts `ownersPastKeptBackstop`) →
//            `adminAlert` kind `kept_backstop`, id = the account — longest-unnamed first, 50 a day;
//   missing  no complete set for YESTERDAY → `OPERATOR_CRITICAL` `backup_missing` (M3).
// Each is claimed once per UTC day by a `notice` marker in the daily ledger, so a second pass the
// same day (an on-demand call) mails nothing more. They go to the operator list (ADMIN_EMAILS); with
// no address the claim is NOT spent — the gap is counted and sent to Sentry instead.

import { sql } from "drizzle-orm";
import journal from "../../../drizzle/meta/_journal.json";
import type { Executor } from "../db/client";
import {
  lastKeptAlerts,
  migrationLevel,
  parentsFirst,
  readPage,
  schemaTableNames,
  tableColumns,
  tableShapes,
  transformUnits,
  type TableShape,
} from "../db/queries/backup";
import { utcDay, addUsageIfUnder } from "../db/queries/ledger";
import { ownersPastKeptBackstop } from "../db/queries/quota";
import { withJobLock } from "../db/queries/trash-jobs";
import { buildMeta } from "../meta";
import { captureError } from "../sentry";
import { sendAdminAlert, sendOperatorCritical } from "../services/email";
import type { BackgroundContext } from "../services/request-context";
import { adminListOf } from "../services/signup-policy";
import type { Job, JobResult, JobRunOptions } from "./index";
import { readsRolledBack } from "./reconcile";

/** Every non-final part of a table's object is exactly this long (≥ R2's 5 MiB minimum). */
export const BACKUP_PART_BYTES = 8 * 1024 * 1024;
export const BACKUP_PREFIX = "b/db/";
/** Rows per keyset page. */
export const BACKUP_PAGE_ROWS = 1_000;
/** The soft deadline when a caller hands none (the cron slot hands 600 s; jobs/index.ts). */
const DEFAULT_SOFT_DEADLINE_MS = 600_000;
/** The lock's transaction outlives the longest pass by this much. */
const LOCK_MARGIN_MS = 120_000;
/** The month's image transformations at which the operator is warned (Free plan: 5,000). */
export const IMAGES_ALARM_UNITS = 4_000;
/** At most this many accounts are named a day by the kept-bytes alarm… */
const KEPT_ALARM_MAX = 50;
/** …chosen, longest-unnamed first, from at most this many accounts past the backstop. */
const KEPT_ALARM_SCAN = 1_000;

export type Detection = "ok" | "rollback" | "unknown" | "not_read";

export type TableRecord = {
  name: string;
  rows: number;
  bytes: number;
  /** Hex SHA-256 of the object's bytes (the gzip stream as stored). */
  sha256: string;
  /** The table's columns in order, `name:type` (`tableColumns`). */
  columns: string[];
  startedAt: string;
  finishedAt: string;
  detection: Detection;
  /** The pass that wrote it. */
  attempt: string;
};

export type Manifest = {
  commit: string;
  /** The one pass — one snapshot — that wrote every object of the set. */
  attempt: string;
  startedAt: string;
  finishedAt: string;
  /** The rollback detector's reading when the pass began. */
  detection: Detection;
  /** The database's migration level: drizzle's last applied migration (journal tag and `when`). */
  migration: { tag: string | null; when: number | null };
  /** Tables exported with their columns and no rows. */
  emptied: string[];
  /** Columns left out of the export, by table. */
  nulled: Record<string, string[]>;
  tables: Array<Pick<TableRecord, "name" | "rows" | "bytes" | "sha256" | "columns">>;
};

export const setPrefix = (date: string): string => `${BACKUP_PREFIX}${date}/`;
export const tableKey = (date: string, table: string): string => `${setPrefix(date)}${table}.jsonl.gz`;
export const progressKey = (date: string, table: string): string =>
  `${setPrefix(date)}_progress/${table}.json`;
export const manifestKey = (date: string): string => `${setPrefix(date)}_manifest.json`;
/** The attempt in progress for a date (T25 reads it to tell this pass's progress records apart). */
export const attemptKey = (date: string): string => `${setPrefix(date)}_attempt.json`;

// ── the chunker ─────────────────────────────────────────────────────────────────────────────

/**
 * Cuts a byte stream into parts of exactly `size` bytes; `finish()` gives the remainder (possibly
 * empty). Holds at most one part plus the chunk being pushed.
 */
export class PartChunker {
  #held: Uint8Array[] = [];
  #heldBytes = 0;
  constructor(readonly size: number = BACKUP_PART_BYTES) {
    if (!Number.isSafeInteger(size) || size < 1) throw new Error("part size must be a positive integer");
  }

  /** The bytes held, not yet in a returned part. */
  get pending(): number {
    return this.#heldBytes;
  }

  /** Adds bytes; returns the parts that are now complete (each exactly `size`). */
  push(chunk: Uint8Array): Uint8Array[] {
    const parts: Uint8Array[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(this.size - this.#heldBytes, chunk.length - offset);
      this.#held.push(chunk.subarray(offset, offset + take));
      this.#heldBytes += take;
      offset += take;
      if (this.#heldBytes === this.size) parts.push(this.#drain());
    }
    return parts;
  }

  /** The remainder: fewer than `size` bytes. */
  finish(): Uint8Array {
    return this.#drain();
  }

  #drain(): Uint8Array {
    const out = new Uint8Array(this.#heldBytes);
    let at = 0;
    for (const piece of this.#held) {
      out.set(piece, at);
      at += piece.length;
    }
    this.#held = [];
    this.#heldBytes = 0;
    return out;
  }
}

// ── one table ───────────────────────────────────────────────────────────────────────────────

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Thrown between pages once the pass's soft deadline has passed. */
export class DeadlineReached extends Error {}

type TableOutcome = { rows: number; bytes: number; sha256: string };

/** A table's pages, read by key until none is left — or until the deadline, between pages. */
export async function* tablePages(
  db: Executor,
  shape: TableShape,
  options: {
    deadline: number;
    pageRows?: number;
    omit?: readonly string[];
    clock?: () => number;
    afterPage?: PassOptions["afterPage"];
  },
): AsyncGenerator<string[]> {
  const size = options.pageRows ?? BACKUP_PAGE_ROWS;
  const clock = options.clock ?? Date.now;
  let after: string | null = null;
  for (let number = 1; ; number++) {
    if (clock() >= options.deadline) throw new DeadlineReached();
    const page = await readPage(db, shape, after, size, options.omit);
    if (page.length === 0) return;
    yield page;
    await options.afterPage?.(shape.name, number, page);
    if (page.length < size) return;
    after = page[page.length - 1]!;
  }
}

const GZIP_JSONL = { httpMetadata: { contentType: "application/gzip" } } as const;

/**
 * Writes `pages` (lines of JSON, without their newlines) as one gzipped JSONL object at `key`.
 * On any failure — the source's (a deadline, a query) or the store's (a part, `complete()`) — the
 * multipart upload, if one was started, is aborted, nothing is left at the key by this call, and
 * the failure is thrown.
 */
export async function writeGzipLines(
  bucket: R2Bucket,
  key: string,
  pages: AsyncIterable<string[]>,
  options: { partBytes?: number } = {},
): Promise<TableOutcome> {
  const chunker = new PartChunker(options.partBytes ?? BACKUP_PART_BYTES);
  const gzip = new CompressionStream("gzip");
  const writer = gzip.writable.getWriter();
  const digest = new crypto.DigestStream("SHA-256");
  const hashWriter = digest.getWriter();
  // Rejects when the upload is given up (the hash is aborted): observed here, read only on success.
  digest.digest.catch(() => {});
  const encoder = new TextEncoder();
  let upload: R2MultipartUpload | null = null;
  const uploaded: R2UploadedPart[] = [];
  let bytes = 0;

  const sendPart = async (part: Uint8Array) => {
    upload ??= await bucket.createMultipartUpload(key, GZIP_JSONL);
    uploaded.push(await upload.uploadPart(uploaded.length + 1, part));
  };
  // The compressed side, read while rows are written: full parts leave as soon as they exist.
  const draining = (async () => {
    const reader = gzip.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      bytes += value.length;
      await hashWriter.write(value);
      for (const part of chunker.push(value)) await sendPart(part);
    }
  })();
  // Should the reading side fail, the writing side must not wait on it forever.
  draining.catch(() => writer.abort().catch(() => {}));

  let rows = 0;
  try {
    for await (const page of pages) {
      for (const line of page) {
        await writer.ready;
        await writer.write(encoder.encode(`${line}\n`));
      }
      rows += page.length;
    }
    await writer.close();
    await draining;
    const tail = chunker.finish();
    await hashWriter.close();
    const sha256 = hex(await digest.digest);
    if (upload === null) {
      await bucket.put(key, tail, GZIP_JSONL);
    } else {
      if (tail.length > 0) await sendPart(tail);
      // A part-size mistake (unequal or short non-final parts) is refused HERE: a failed table.
      await (upload as R2MultipartUpload).complete(uploaded);
    }
    return { rows, bytes, sha256 };
  } catch (error) {
    await writer.abort(error).catch(() => {});
    await draining.catch(() => {});
    await hashWriter.abort().catch(() => {});
    if (upload !== null) await (upload as R2MultipartUpload).abort().catch(() => {});
    throw error;
  }
}

// ── a pass ──────────────────────────────────────────────────────────────────────────────────

/**
 * The export order: children before parents (parents-first, reversed). Inside one snapshot the
 * order changes nothing about consistency; it is kept because a restore that meets a set from
 * elsewhere still resolves a straddle best this way (a parent removed after its children were
 * written is the one case the restore's ON DELETE resolution handles).
 */
export function exportOrder(shapes: Map<string, TableShape>): string[] {
  return parentsFirst(shapes).reverse();
}

/**
 * Exported with their columns and NO rows (brief Addendum 3, M4): live credentials with no
 * recovery value — every session token, every pending verification (password-reset and
 * change-email identifiers). The restore empties both anyway: everyone signs in again.
 */
export const EMPTIED_TABLES = ["session", "verification"] as const;
/**
 * Columns left out of the export (loaded as NULL): the Google OAuth tokens Better Auth keeps on
 * `account` — live credentials for another service; a restored user's next Google sign-in
 * writes new ones. Password hashes and TOTP secrets STAY: without them nobody could sign in.
 */
export const NULLED_COLUMNS: Record<string, string[]> = {
  account: ["access_token", "refresh_token", "id_token"],
};

export type PassOptions = {
  softDeadlineMs?: number;
  /** The set's UTC date. Today's by default. */
  date?: string;
  /** The object store (the environment's `FILES` bucket by default). */
  bucket?: R2Bucket;
  /** Only these tables, in export order (tests). Every schema table by default. */
  tables?: string[];
  pageRows?: number;
  partBytes?: number;
  /** The clock the deadline is read on (tests move it). `Date.now` by default. */
  clock?: () => number;
  /** Called after every page has been written on (tests interleave work between pages). */
  afterPage?: (table: string, page: number, lines: readonly string[]) => void | Promise<void>;
};

export type PassResult = JobResult & {
  /** Tables this pass wrote. */
  written: string[];
  outcome: "ok" | "partial" | "already_complete" | "overlap";
  /** This pass's attempt id (absent when it wrote nothing). */
  attempt?: string;
};

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? ((await object.json()) as T) : null;
}

/** The pass's snapshot transaction: its statements may run this long, and it may idle this long. */
const SNAPSHOT_STATEMENT_MS = 60_000;
const SNAPSHOT_IDLE_MS = 120_000;

/** The journal tag of a migration level (drizzle stores the journal `when` as `created_at`). */
function tagOf(when: number | null): string | null {
  return journal.entries.find((entry) => entry.when === when)?.tag ?? null;
}

/** One bounded pass. Throws when a table fails (after aborting its upload). */
export async function backupPass(bg: BackgroundContext, options: PassOptions = {}): Promise<PassResult> {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const softDeadlineMs = options.softDeadlineMs ?? DEFAULT_SOFT_DEADLINE_MS;
  const deadline = startedAt + softDeadlineMs;
  const bucket = options.bucket ?? bg.env.FILES;
  const date = options.date ?? utcDay(new Date(startedAt));

  if (await bucket.head(manifestKey(date))) return { done: true, written: [], outcome: "already_complete" };

  const locked = await withJobLock(bg.db, "backup", softDeadlineMs + LOCK_MARGIN_MS, async () => {
    // Again under the lock: a pass that finished between the look above and this lock must not
    // have its complete set overwritten (delta review d-m1).
    if (await bucket.head(manifestKey(date)))
      return { done: true, written: [], outcome: "already_complete" } as const;
    // A new attempt: whatever an earlier pass of this date left is overwritten, never reused.
    const attempt = `${new Date(startedAt).toISOString()}-${crypto.randomUUID().slice(0, 8)}`;
    await bucket.put(
      attemptKey(date),
      JSON.stringify({ attempt, startedAt: new Date(startedAt).toISOString() }),
      {
        httpMetadata: { contentType: "application/json" },
      },
    );
    const detection: Detection = (await readsRolledBack(bg.env, bg.db)) ? "rollback" : "ok";
    // ONE SNAPSHOT for the whole set (Addendum 3, M1): every page of every table is read in this
    // one REPEATABLE READ, READ ONLY transaction, so no move, purge or insert during the pass can
    // put two moments into the set.
    return bg.db.transaction(
      async (tx) => {
        await tx.execute(sql`SELECT set_config('statement_timeout', ${String(SNAPSHOT_STATEMENT_MS)}, true),
          set_config('idle_in_transaction_session_timeout', ${String(SNAPSHOT_IDLE_MS)}, true)`);
        const names = options.tables ?? schemaTableNames();
        const shapes = await tableShapes(tx, names);
        const columns = await tableColumns(tx, names);
        const when = await migrationLevel(tx);
        const order = options.tables ? options.tables : exportOrder(shapes);
        const written: string[] = [];
        const records: TableRecord[] = [];
        for (const name of order) {
          if (clock() >= deadline) return { done: false, written, outcome: "partial", attempt } as const;
          const tableStarted = new Date().toISOString();
          const emptied = (EMPTIED_TABLES as readonly string[]).includes(name);
          let outcome: TableOutcome;
          try {
            outcome = await writeGzipLines(
              bucket,
              tableKey(date, name),
              emptied
                ? (async function* () {})()
                : tablePages(tx, shapes.get(name)!, {
                    deadline,
                    pageRows: options.pageRows,
                    omit: NULLED_COLUMNS[name] ?? [],
                    clock,
                    afterPage: options.afterPage,
                  }),
              { partBytes: options.partBytes },
            );
          } catch (error) {
            if (error instanceof DeadlineReached)
              return { done: false, written, outcome: "partial", attempt } as const;
            bg.metric("job", { kind: "backup", outcome: "error", reason: name });
            throw error;
          }
          const record: TableRecord = {
            name,
            ...outcome,
            columns: columns.get(name) ?? [],
            startedAt: tableStarted,
            finishedAt: new Date().toISOString(),
            detection,
            attempt,
          };
          // Progress for a caller that wants it (T25 lists `_progress/`); never read back by a pass.
          await bucket.put(progressKey(date, name), JSON.stringify(record), {
            httpMetadata: { contentType: "application/json" },
          });
          records.push(record);
          written.push(name);
          bg.metric("job", { kind: "backup", outcome: "rows", reason: name }, outcome.rows);
          bg.metric("job", { kind: "backup", outcome: "bytes", reason: name }, outcome.bytes);
        }
        await writeManifest(bucket, date, {
          commit: buildMeta().commit,
          attempt,
          startedAt: new Date(startedAt).toISOString(),
          finishedAt: new Date().toISOString(),
          detection,
          migration: { tag: tagOf(when), when },
          emptied: [...EMPTIED_TABLES],
          nulled: NULLED_COLUMNS,
          tables: records.map(({ name, rows, bytes, sha256, columns: cols }) => ({
            name,
            rows,
            bytes,
            sha256,
            columns: cols,
          })),
        });
        bg.metric("job", { kind: "backup", outcome: "ok" });
        return { done: true, written, outcome: "ok", attempt } as const;
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  });
  if (!locked.held) {
    bg.metric("job", { kind: "backup", outcome: "overlap" });
    return { done: false, written: [], outcome: "overlap" };
  }
  if (!locked.value.done) bg.metric("job", { kind: "backup", outcome: "partial" });
  return { ...locked.value, written: [...locked.value.written] };
}

/** The manifest, then read back: every listed object must be there with its recorded size. */
async function writeManifest(bucket: R2Bucket, date: string, manifest: Manifest): Promise<void> {
  const key = manifestKey(date);
  await bucket.put(key, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  const back = await readJson<Manifest>(bucket, key);
  if (!back || back.attempt !== manifest.attempt || back.tables.length !== manifest.tables.length)
    throw new Error("backup: the manifest did not read back");
  for (const table of back.tables) {
    const head = await bucket.head(tableKey(date, table.name));
    if (!head || head.size !== table.bytes)
      throw new Error("backup: a listed table object is missing or short");
  }
}

// ── the alarms ──────────────────────────────────────────────────────────────────────────────

/** The first day of `at`'s UTC month and of the next one, as `YYYY-MM-DD`. */
export function monthOf(at: Date): { from: string; to: string } {
  const from = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const to = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { from: utcDay(from), to: utcDay(to) };
}

/** Claims today's marker for `key`: true for exactly one caller per UTC day. */
const claimDaily = (bg: BackgroundContext, day: string, key: string) =>
  addUsageIfUnder(bg.db, day, "notice", key, { bytes: 0, count: 1 }, { count: 1 });

/**
 * The operator addresses — or, when there are none, nothing is claimed and the gap is made
 * visible instead (metric + Sentry): an alarm that told nobody must not spend its day.
 */
function recipients(bg: BackgroundContext, alarm: string): string[] {
  const addresses = [...adminListOf(bg.env).addresses];
  if (addresses.length === 0) {
    bg.metric("error", { kind: "admin_alert", reason: "no_recipient" });
    captureError(new Error(`backup alarm ${alarm}: no operator address is configured — nobody was told`), {
      kind: "job",
      job: "backup",
      reason: alarm,
    });
  }
  return addresses;
}

export type AlarmOutcome = "quiet" | "mailed" | "claimed" | "no_recipient";

/** The Images budget alarm: the month's transformations at or past `IMAGES_ALARM_UNITS`. */
export async function imagesAlarm(bg: BackgroundContext, at: Date = new Date()): Promise<AlarmOutcome> {
  const { from, to } = monthOf(at);
  const units = await transformUnits(bg.db, from, to);
  if (units < IMAGES_ALARM_UNITS) return "quiet";
  const addresses = recipients(bg, "images_budget");
  if (addresses.length === 0) return "no_recipient";
  const day = utcDay(at);
  if (!(await claimDaily(bg, day, "images_budget"))) return "claimed";
  bg.metric("job", { kind: "backup", outcome: "images_budget" }, units);
  for (const address of addresses) await sendAdminAlert(bg, { to: address, kind: "images_budget", id: day });
  return "mailed";
}

/**
 * The kept-bytes backstop alarm: accounts past it now, once per account per UTC day, at most
 * `limit` a day — those named longest ago (or never) first, so that every account is named in turn
 * rather than the same first ones every day. Returns those mailed about.
 */
export async function keptBackstopAlarm(
  bg: BackgroundContext,
  at: Date = new Date(),
  limit = KEPT_ALARM_MAX,
): Promise<string[]> {
  const past = await ownersPastKeptBackstop(bg.db, { limit: KEPT_ALARM_SCAN });
  if (past.length === 0) return [];
  const addresses = recipients(bg, "kept_backstop");
  if (addresses.length === 0) return [];
  const last = await lastKeptAlerts(bg.db, past);
  const turn = [...past].sort((x, y) => {
    const a = last.get(x) ?? "";
    const b = last.get(y) ?? "";
    return a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1;
  });
  const day = utcDay(at);
  const mailed: string[] = [];
  for (const owner of turn) {
    if (mailed.length >= limit) break;
    if (!(await claimDaily(bg, day, `kept_backstop:${owner}`))) continue;
    for (const address of addresses)
      await sendAdminAlert(bg, { to: address, kind: "kept_backstop", id: owner });
    mailed.push(owner);
  }
  if (mailed.length) bg.metric("job", { kind: "backup", outcome: "kept_backstop" }, mailed.length);
  return mailed;
}

/**
 * No complete set for YESTERDAY (Addendum 3, M3): the secondary backup has stopped existing, and
 * only this says so — `OPERATOR_CRITICAL` `backup_missing`, once per UTC day. (The day a
 * deployment's first backup is due, it fires once: there is no set for the day before either.)
 */
export async function backupMissingAlarm(
  bg: BackgroundContext,
  at: Date = new Date(),
  bucket: R2Bucket = bg.env.FILES,
): Promise<AlarmOutcome> {
  const yesterday = utcDay(new Date(at.getTime() - 86_400_000));
  if (await bucket.head(manifestKey(yesterday))) return "quiet";
  bg.metric("job", { kind: "backup", outcome: "missing" });
  const addresses = recipients(bg, "backup_missing");
  if (addresses.length === 0) return "no_recipient";
  if (!(await claimDaily(bg, utcDay(at), "backup_missing"))) return "claimed";
  for (const address of addresses) {
    await sendOperatorCritical(bg, { to: address, event: "backup_missing", id: yesterday });
  }
  return "mailed";
}

/** Each alarm on its own: one failing never stops the others, nor the pass's own result. */
async function alarms(bg: BackgroundContext, at: Date): Promise<void> {
  for (const [name, alarm] of [
    ["images_budget", () => imagesAlarm(bg, at)],
    ["kept_backstop", () => keptBackstopAlarm(bg, at)],
    ["backup_missing", () => backupMissingAlarm(bg, at)],
  ] as const) {
    try {
      await alarm();
    } catch (error) {
      captureError(error, { kind: "job", job: "backup", reason: name });
      bg.metric("job", { kind: "backup", outcome: "alarm_error", reason: name });
    }
  }
}

export const job: Job = {
  name: "backup",
  cron: "0 2 * * *",
  async run(bg: BackgroundContext, _env: Env, _event: ScheduledController, opts?: JobRunOptions) {
    try {
      const result = await backupPass(bg, { softDeadlineMs: opts?.softDeadlineMs });
      return { done: result.done };
    } finally {
      await alarms(bg, new Date());
    }
  },
};

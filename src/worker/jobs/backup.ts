// The nightly logical export (T27; cron `0 2 * * *`, FIRST in its slot — before user-purge and
// reconcile, so that night's purges are still in that night's export). Metadata only: no file
// bytes. Primary recovery is Neon's point-in-time restore; this is the second copy.
//
//   b/db/<YYYY-MM-DD UTC>/<table>.jsonl.gz       every table of the schema, one JSON row per line
//   b/db/<date>/_progress/<table>.json           a completed table: { name, rows, bytes, sha256, … }
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
// RESUMABLE, BY TABLE. A pass exports tables (children before parents — see `exportOrder`) until
// its soft deadline, which it is handed and honours exactly: 600 s from the cron slot (jobs/index.ts),
// 20 s or 540 s (streamed) from T25's on-demand call. The deadline is looked at between pages; a
// table cut by it is aborted and redone whole by the next pass. Each finished table leaves its
// progress record; a later pass of the SAME UTC date skips those, and only the pass that finds
// every table done writes the manifest. A pass that starts on a new date starts a new set: an
// unfinished date directory stays without a manifest, and the restore refuses it. So a dated set is
// not one snapshot — rows can change between the passes (the restore applies each foreign key's own
// ON DELETE rule to a row whose parent went in between, and names it).
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
// TWO ALARMS RUN IN THE TAIL OF EVERY PASS — done or not, failed or not (brief R-6), each on its own:
//   images   the month's image transformations (the `transform_user` ledger units) at or past
//            IMAGES_ALARM_UNITS (4,000 of the Free plan's 5,000/month; spike S15: no Cloudflare
//            alert can be set there) → `adminAlert` kind `images_budget`, id = the UTC date;
//   kept     accounts past the kept-bytes backstop now (quota.ts `ownersPastKeptBackstop`) →
//            `adminAlert` kind `kept_backstop`, id = the account.
// Each is claimed once per UTC day by a `notice` marker in the daily ledger, so a second pass the
// same day (an on-demand call) mails nothing more. They go to the operator list (ADMIN_EMAILS).

import { utcDay, addUsageIfUnder } from "../db/queries/ledger";
import {
  parentsFirst,
  readPage,
  schemaTableNames,
  tableShapes,
  transformUnits,
  type TableShape,
} from "../db/queries/backup";
import { ownersPastKeptBackstop } from "../db/queries/quota";
import { withJobLock } from "../db/queries/trash-jobs";
import { buildMeta } from "../meta";
import { captureError } from "../sentry";
import { sendAdminAlert } from "../services/email";
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
/** At most this many accounts are named per pass by the kept-bytes alarm. */
const KEPT_ALARM_MAX = 50;

export type Detection = "ok" | "rollback" | "unknown" | "not_read";

export type TableRecord = {
  name: string;
  rows: number;
  bytes: number;
  /** Hex SHA-256 of the object's bytes (the gzip stream as stored). */
  sha256: string;
  startedAt: string;
  finishedAt: string;
  detection: Detection;
};

export type Manifest = {
  commit: string;
  startedAt: string;
  finishedAt: string;
  /** "ok" only when every table was written while the detector read ok. */
  detection: Detection;
  tables: Array<Pick<TableRecord, "name" | "rows" | "bytes" | "sha256">>;
};

export const setPrefix = (date: string): string => `${BACKUP_PREFIX}${date}/`;
export const tableKey = (date: string, table: string): string => `${setPrefix(date)}${table}.jsonl.gz`;
export const progressKey = (date: string, table: string): string =>
  `${setPrefix(date)}_progress/${table}.json`;
export const manifestKey = (date: string): string => `${setPrefix(date)}_manifest.json`;

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
  db: BackgroundContext["db"],
  shape: TableShape,
  options: { deadline: number; pageRows?: number },
): AsyncGenerator<string[]> {
  const size = options.pageRows ?? BACKUP_PAGE_ROWS;
  let after: string | null = null;
  for (;;) {
    if (Date.now() >= options.deadline) throw new DeadlineReached();
    const page = await readPage(db, shape, after, size);
    if (page.length === 0) return;
    yield page;
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
 * The export order: children before parents (parents-first, reversed). A row created between two
 * passes is then simply not in the set; the only straddle left is a parent removed after its
 * children were written — which the restore resolves by the foreign key's own ON DELETE rule. The
 * other order would strand every row created between passes under a parent the set lacks.
 */
export function exportOrder(shapes: Map<string, TableShape>): string[] {
  return parentsFirst(shapes).reverse();
}

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
  /** When the alarms look at the day and month (now by default). */
  at?: Date;
};

export type PassResult = JobResult & {
  /** Tables this pass wrote. */
  written: string[];
  outcome: "ok" | "partial" | "already_complete" | "overlap";
};

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? ((await object.json()) as T) : null;
}

/** The completed tables of a date: the progress records present. */
async function completedTables(bucket: R2Bucket, date: string): Promise<Map<string, TableRecord>> {
  const done = new Map<string, TableRecord>();
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix: `${setPrefix(date)}_progress/`, cursor });
    for (const object of listed.objects) {
      const record = await readJson<TableRecord>(bucket, object.key);
      if (record) done.set(record.name, record);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return done;
}

/** One bounded pass. Throws when a table fails (after aborting its upload). */
export async function backupPass(bg: BackgroundContext, options: PassOptions = {}): Promise<PassResult> {
  const startedAt = Date.now();
  const softDeadlineMs = options.softDeadlineMs ?? DEFAULT_SOFT_DEADLINE_MS;
  const deadline = startedAt + softDeadlineMs;
  const bucket = options.bucket ?? bg.env.FILES;
  const date = options.date ?? utcDay(new Date(startedAt));

  if (await bucket.head(manifestKey(date))) return { done: true, written: [], outcome: "already_complete" };

  const locked = await withJobLock(bg.db, "backup", softDeadlineMs + LOCK_MARGIN_MS, async () => {
    const names = options.tables ?? schemaTableNames();
    const shapes = await tableShapes(bg.db, names);
    const order = options.tables ? options.tables : exportOrder(shapes);
    const done = await completedTables(bucket, date);
    const detection: Detection = (await readsRolledBack(bg.env, bg.db)) ? "rollback" : "ok";
    const written: string[] = [];
    for (const name of order) {
      if (done.has(name)) continue;
      if (Date.now() >= deadline) return { done: false, written, outcome: "partial" } as const;
      const tableStarted = new Date().toISOString();
      let outcome: TableOutcome;
      try {
        outcome = await writeGzipLines(
          bucket,
          tableKey(date, name),
          tablePages(bg.db, shapes.get(name)!, { deadline, pageRows: options.pageRows }),
          { partBytes: options.partBytes },
        );
      } catch (error) {
        if (error instanceof DeadlineReached) return { done: false, written, outcome: "partial" } as const;
        bg.metric("job", { kind: "backup", outcome: "error", reason: name });
        throw error;
      }
      const record: TableRecord = {
        name,
        ...outcome,
        startedAt: tableStarted,
        finishedAt: new Date().toISOString(),
        detection,
      };
      await bucket.put(progressKey(date, name), JSON.stringify(record), {
        httpMetadata: { contentType: "application/json" },
      });
      done.set(name, record);
      written.push(name);
      bg.metric("job", { kind: "backup", outcome: "rows", reason: name }, outcome.rows);
      bg.metric("job", { kind: "backup", outcome: "bytes", reason: name }, outcome.bytes);
    }
    await writeManifest(bucket, date, order, done);
    bg.metric("job", { kind: "backup", outcome: "ok" });
    return { done: true, written, outcome: "ok" } as const;
  });
  if (!locked.held) {
    bg.metric("job", { kind: "backup", outcome: "overlap" });
    return { done: false, written: [], outcome: "overlap" };
  }
  if (!locked.value.done) bg.metric("job", { kind: "backup", outcome: "partial" });
  return { ...locked.value, written: [...locked.value.written] };
}

/** The manifest, then read back: every listed object must be there with its recorded size. */
async function writeManifest(
  bucket: R2Bucket,
  date: string,
  order: string[],
  done: Map<string, TableRecord>,
): Promise<void> {
  const records = order.map((name) => done.get(name)!);
  const manifest: Manifest = {
    commit: buildMeta().commit,
    startedAt: records.map((record) => record.startedAt).sort()[0] ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    detection: records.every((record) => record.detection === "ok")
      ? "ok"
      : (records.find((record) => record.detection !== "ok")?.detection ?? "unknown"),
    tables: records.map(({ name, rows, bytes, sha256 }) => ({ name, rows, bytes, sha256 })),
  };
  const key = manifestKey(date);
  await bucket.put(key, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
  const back = await readJson<Manifest>(bucket, key);
  if (!back || back.tables.length !== manifest.tables.length)
    throw new Error("backup: the manifest did not read back");
  for (const table of back.tables) {
    const head = await bucket.head(tableKey(date, table.name));
    if (!head || head.size !== table.bytes)
      throw new Error("backup: a listed table object is missing or short");
  }
}

// ── the two alarms ──────────────────────────────────────────────────────────────────────────

/** The first day of `at`'s UTC month and of the next one, as `YYYY-MM-DD`. */
export function monthOf(at: Date): { from: string; to: string } {
  const from = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const to = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { from: utcDay(from), to: utcDay(to) };
}

/** Claims today's marker for `key`: true for exactly one caller per UTC day. */
const claimDaily = (bg: BackgroundContext, day: string, key: string) =>
  addUsageIfUnder(bg.db, day, "notice", key, { bytes: 0, count: 1 }, { count: 1 });

/** Mails every operator address. True when there was one to mail. */
async function mailOperators(
  bg: BackgroundContext,
  kind: "images_budget" | "kept_backstop",
  id: string,
): Promise<boolean> {
  const addresses = [...adminListOf(bg.env).addresses];
  for (const to of addresses) await sendAdminAlert(bg, { to, kind, id });
  return addresses.length > 0;
}

/** The Images budget alarm: the month's transformations at or past `IMAGES_ALARM_UNITS`. */
export async function imagesAlarm(
  bg: BackgroundContext,
  at: Date = new Date(),
): Promise<"quiet" | "mailed" | "claimed"> {
  const { from, to } = monthOf(at);
  const units = await transformUnits(bg.db, from, to);
  if (units < IMAGES_ALARM_UNITS) return "quiet";
  const day = utcDay(at);
  if (!(await claimDaily(bg, day, "images_budget"))) return "claimed";
  bg.metric("job", { kind: "backup", outcome: "images_budget" }, units);
  await mailOperators(bg, "images_budget", day);
  return "mailed";
}

/** The kept-bytes backstop alarm: each account past it now, once per UTC day. Returns those mailed about. */
export async function keptBackstopAlarm(
  bg: BackgroundContext,
  at: Date = new Date(),
  limit = KEPT_ALARM_MAX,
): Promise<string[]> {
  const day = utcDay(at);
  const mailed: string[] = [];
  for (const owner of await ownersPastKeptBackstop(bg.db, { limit })) {
    if (!(await claimDaily(bg, day, `kept_backstop:${owner}`))) continue;
    await mailOperators(bg, "kept_backstop", owner);
    mailed.push(owner);
  }
  if (mailed.length) bg.metric("job", { kind: "backup", outcome: "kept_backstop" }, mailed.length);
  return mailed;
}

/** Each alarm on its own: one failing never stops the other, nor the pass's own result. */
async function alarms(bg: BackgroundContext, at: Date): Promise<void> {
  for (const [name, alarm] of [
    ["images_budget", () => imagesAlarm(bg, at)],
    ["kept_backstop", () => keptBackstopAlarm(bg, at)],
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

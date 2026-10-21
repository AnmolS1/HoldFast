// Thumbnails: one transform per (node, version, size), kept in the object store under `t/`.
//
//   const made = await makeThumbnail(c, node, size, owner);   called on a cache MISS only
//
// THE OUTPUT IS WEBP — ALWAYS, FOR EVERY INPUT AND EVERY SIZE. This is the privacy rule, not a
// format preference: the image service has no option that strips what a camera wrote into a
// picture (where it was taken, by whom). What decides whether that survives is the OUTPUT FORMAT,
// and a WebP output carries none of it. So the format below is a literal, the cache key ends in
// `.webp`, and nothing in this file passes any other option about it.
//
// DEGRADE, NEVER FAIL. A type on the thumbnail list is one this code may TRY. Whatever the image
// service answers with — a coded error (the monthly quota, an input it cannot decode), an untyped
// "Network connection lost." (its answer to an oversize input), anything thrown — and a reached
// daily transform ceiling all end the same way: no thumbnail, nothing written, ONE attempt. The
// caller answers `404` and the page shows the type icon. Never an error response, never a retry.
//
// AT MOST THREE CALLS OF THE IMAGE SERVICE PER THUMBNAIL PER DAY — AND ONE UNIT OF ITS OWNER'S.
// Nothing is cached for a failure, and a burst of misses for one thumbnail arrives before any of
// them has finished — so without a memory every such request, by anyone holding a URL for it and
// at no cost to them, would take another unit of the owner's day and another call of the image
// service. Two marker rows per (node, version, size) in the daily ledger, under the subject
// `notice` (rows no total is summed from), bound the two separately:
//   `thumb_failed:…`  `count` = calls of the image service claimed today. A call is claimed by
//             one add-if-under statement immediately before it is made (at most
//             THUMB_CALLS_PER_DAY), and NOTHING gives it back — not a made thumbnail, not a
//             failed cache write, not an asker who went away, not an invocation that was cut.
//             This is the wallet bound. Once the service has said this thumbnail cannot be made
//             (a coded failure: its quota, an input it cannot decode; an empty output) — or its
//             source object is missing — the count is pushed past the cap: no call until the
//             next UTC day.
//   `thumb_unit:…`    the owner's `transform_user` unit for this thumbnail today. `bytes` = the
//             time (epoch seconds) one request took the right to charge it — the HOLD; `count` =
//             1 once it was charged, which is final for the day. Every further call for the
//             thumbnail that day is free to the owner (the frozen `consumeCeiling` refunds no
//             count, so a unit is never taken twice instead of taken and given back). A request
//             that finds the unit held but not yet charged does not call: the owner might yet be
//             refused, and a call made meanwhile would pass the owner's ceiling.
//             THE HOLD CANNOT WEDGE THE THUMBNAIL. Whatever ends the holder's turn without the
//             charge being marked — the owner's ceiling refusing it, the ceiling service or the
//             database throwing — gives ITS OWN hold back (`finally`; a conditional UPDATE that
//             names the hold's time, so a holder that comes back after its hold was taken over
//             touches nothing), and the request answers the icon. A holder that never comes back (an invocation cut between the hold and the
//             mark: no `finally` runs) leaves a hold that the first request after
//             HOLD_STALE_SECONDS TAKES OVER — one conditional UPDATE naming that hold (its time,
//             as read), so one winner, and never a hold given back and re-taken meanwhile. A
//             takeover is no free call: calls are counted on the other row, and nothing gives
//             them back.
// A request that gets neither answers "no thumbnail" at once: no unit, no call, nothing written —
// the page's next load finds the cached thumbnail or the marker. So per thumbnail per day: at
// most 3 calls and 1 unit, whoever asks, however often and however they leave; a known failure
// costs 1 call; after 3 calls without a cached result the thumbnail is the icon until 00:00 UTC.
// A new version of the file has new keys and so a fresh day; so has another size.
//
// NOTHING IS LEFT BEHIND FOR A FILE THAT CHANGED MEANWHILE. A Replace, a purge or an admin
// deletion that runs while a transform is in flight deletes the node's thumbnails before this
// one is written. So the cache object is written FIRST and the node read AFTER it (it still
// exists, is not hidden, and is still at the version that was transformed); if not, the object
// just written is deleted and the answer is the icon. (Put-then-check: a change that commits
// after a check made before the write would delete before the write lands.)
//
// THE CALL DOES NOT DEPEND ON THE ASKER STAYING. Once claimed, the transform and its cache write
// are handed to the request's deferred work as well as awaited: an asker who goes away
// mid-transform leaves a cached thumbnail behind.
//
// NO LOCK. Concurrent misses that hold a call each transform and each write the same bytes to
// the same key — two writers of one key are harmless.

import type { Context } from "hono";
import { THUMB_INPUT_MAX_BYTES, type ThumbSize } from "../../shared/constants";
import { addUsageIfUnder, totalsOn, utcDay } from "../db/queries/ledger";
import { releaseHold, takeOverStaleHold } from "../db/queries/files-host";
import { getNode } from "../db/queries/nodes";
import { effectiveHidden } from "../db/queries/tree";
import { tryConsumeCeiling } from "./ceilings";
import { now } from "./clock";
import { db, defer, type AppEnv } from "./request-context";
import { storage, thumbKey } from "./storage";

/** The one content type a thumbnail is stored and served with. */
export const THUMB_TYPE = "image/webp";
const QUALITY = 80;

export type ThumbSource = { id: string; versionId: string; r2Key: string; size: number };
export type ThumbOwner = { id: string; account: { quotaBytes: number; createdAt: Date } };

export type MadeThumbnail =
  /** `stored`: the cached object, or null when writing it failed (the thumbnail is served anyway). */
  { ok: true; buffer: ArrayBuffer; stored: R2Object | null } | { ok: false; reason: string };

const none = (reason: string): MadeThumbnail => ({ ok: false, reason });

/** How many calls of the image service one thumbnail — one size of one version of a file — gets a day. */
export const THUMB_CALLS_PER_DAY = 3;

/**
 * The largest thumbnail the cache stores for a variant: four bytes a pixel — an uncompressed
 * RGBA image of `size` × `size`, which a lossy WebP at quality 80 never reaches. A thumbnail is a
 * STILL: the output asks `anim: false` ("converts the first frame of an animated input to a still
 * image" — developers.cloudflare.com/images/optimization/features/#anim; the binding's default
 * keeps every frame, developers.cloudflare.com/images/optimization/binding/), so an animated GIF
 * or WebP is one frame too and the bound holds for it. An output above
 * it is not stored or served (a failure the service gave: no further call that day). It is the
 * room an asker must have on their own day before a thumbnail is made for them.
 */
export const THUMB_BYTES_PER_PIXEL = 4;

export function thumbMaxBytes(size: ThumbSize): number {
  return size * size * THUMB_BYTES_PER_PIXEL;
}

/** A hold on the owner's unit older than this, never charged, is taken over by the next request. */
export const HOLD_STALE_SECONDS = 300;

type Key = Pick<ThumbSource, "id" | "versionId">;

/** The id of a thumbnail's call marker (ledger subject `notice`). */
export function failureMarker(node: Key, size: ThumbSize): string {
  return `thumb_failed:${node.id}:${node.versionId}:${size}`;
}

/** The id of a thumbnail's owner-unit marker (ledger subject `notice`). */
export function unitMarker(node: Key, size: ThumbSize): string {
  return `thumb_unit:${node.id}:${node.versionId}:${size}`;
}

const hasCode = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" || (typeof code === "string" && /^\d{1,6}$/.test(code));
};

/**
 * The owner's unit for this thumbnail today: charged by the one request that holds it, or
 * already charged. Anything else — the owner's ceiling refused it, another request holds it,
 * the charge failed — means no call may be made now. Never throws.
 */
async function ownerPaid(
  c: Context<AppEnv>,
  node: Key,
  size: ThumbSize,
  owner: ThumbOwner,
  day: string,
): Promise<"paid" | "ceiling" | "busy" | "error"> {
  const marker = unitMarker(node, size);
  const at = Math.floor(now(c).getTime() / 1000);
  // One statement: a hold only where there is none, and none once the unit was charged.
  const hold = (bytes: number) =>
    addUsageIfUnder(db(c), day, "notice", marker, { bytes, count: 0 }, { bytes, count: 0 });
  // (The hold's time is its identity: `bytes` = `at` exactly, never a sum.)
  if (!(await hold(at))) {
    const seen = await totalsOn(db(c), day, "notice", marker);
    if (seen.count > 0) return "paid";
    if (seen.bytes === 0) {
      // Given back since: a free slot, taken by the ordinary acquire — never by a takeover.
      if (!(await hold(at))) return "busy";
    } else if (seen.bytes > at - HOLD_STALE_SECONDS) {
      return "busy";
    } else if (!(await takeOverStaleHold(db(c), day, marker, at, seen.bytes, at - HOLD_STALE_SECONDS))) {
      // A hold nobody came back to is taken over by ONE conditional UPDATE that names it as it
      // was read (its time): a hold given back and taken again meanwhile is another hold, and
      // of any number of takers at once exactly one matches.
      return "busy";
    }
  }
  let charged = false;
  try {
    const unit = await tryConsumeCeiling(c, "transform_user", owner, { count: 1 });
    if (!unit.ok) return "ceiling";
    await addUsageIfUnder(db(c), day, "notice", marker, { bytes: 0, count: 1 }, { count: 1 });
    charged = true;
    return "paid";
  } catch {
    return "error";
  } finally {
    if (!charged) {
      // No call was made: the thumbnail does not lose its day. Only THIS request's hold is given
      // back (it names its time): a hold taken over meanwhile is someone else's and stays.
      // Not given back → taken over later.
      await releaseHold(db(c), day, marker, at).catch(() => false);
    }
  }
}

/** Claims one of today's calls of the image service. Never given back. */
function claimCall(c: Context<AppEnv>, marker: string, day: string): Promise<boolean> {
  return addUsageIfUnder(
    db(c),
    day,
    "notice",
    marker,
    { bytes: 0, count: 1 },
    { count: THUMB_CALLS_PER_DAY },
  );
}

/** No further call today. Never throws: the answer is a 404 either way. */
async function giveUp(c: Context<AppEnv>, marker: string, day: string): Promise<void> {
  try {
    await addUsageIfUnder(db(c), day, "notice", marker, { bytes: 0, count: THUMB_CALLS_PER_DAY }, {});
  } catch {
    // Not recorded: the calls that are left may still be made.
  }
}

/** A short tag for the metric: the service's own code when it gave one. Never its message. */
function reasonOf(error: unknown): string {
  return hasCode(error) ? `images_${String((error as { code: unknown }).code)}` : "images_error";
}

/**
 * Transforms the file into a `size`-pixel WebP, stores it under its versioned key and returns the
 * bytes. `{ ok: false }` for every way this can not happen — see the header. The caller has
 * already decided the file is eligible (type, scan state, size) and that the cache has no object.
 */
export async function makeThumbnail(
  c: Context<AppEnv>,
  node: ThumbSource,
  size: ThumbSize,
  owner: ThumbOwner,
): Promise<MadeThumbnail> {
  // The image service's failure for a larger input is an untyped connection error: never ask.
  if (!Number.isFinite(node.size) || node.size > THUMB_INPUT_MAX_BYTES) return none("too_large");

  // EVERYTHING from the hold on is the request's deferred work — registered (and so handed to
  // the platform's `waitUntil`) before its first statement — as well as awaited here. A client
  // that goes away cannot cut it between the hold and the mark, nor between the call and the
  // cache write: "ctx.waitUntil() can extend execution for up to 30 seconds after the response
  // is sent or the client disconnects" (developers.cloudflare.com/workers/runtime-apis/context/);
  // awaited work that is not passed to it "may be canceled" when the client disconnects
  // (developers.cloudflare.com/workers/platform/limits/). What remains is an isolate that dies,
  // or work that outlives those 30 s: then a hold is taken over after HOLD_STALE_SECONDS.
  const work = pipeline(c, node, size, owner);
  try {
    defer(c, work);
  } catch {
    // The request's deferred work is full: the pipeline runs with the request alone.
  }
  return work;
}

/** Hold → unit → mark → claim a call → transform → write → re-check. Never rejects. */
async function pipeline(
  c: Context<AppEnv>,
  node: ThumbSource,
  size: ThumbSize,
  owner: ThumbOwner,
): Promise<MadeThumbnail> {
  const day = utcDay(now(c));
  const paid = await ownerPaid(c, node, size, owner, day).catch(() => "error" as const);
  if (paid !== "paid") return none(paid === "busy" ? "unit_busy" : paid);
  const marker = failureMarker(node, size);
  try {
    if (!(await claimCall(c, marker, day))) return none("attempted_today");
  } catch {
    return none("error");
  }
  return attempt(c, node, size, marker, day);
}

/** The transform and its cache write, with what becomes of the marker. Never rejects. */
async function attempt(
  c: Context<AppEnv>,
  node: ThumbSource,
  size: ThumbSize,
  marker: string,
  day: string,
): Promise<MadeThumbnail> {
  const store = storage(c.env);
  let buffer: ArrayBuffer;
  try {
    const source = await store.get(node.r2Key);
    if (!source || source.kind !== "body") {
      await giveUp(c, marker, day);
      return none("no_source");
    }
    const result = await c.env.IMAGES.input(source.object.body)
      .transform({ width: size, height: size, fit: "scale-down" })
      .output({ format: THUMB_TYPE, quality: QUALITY, anim: false });
    // Read whole: the store takes no stream of unknown length, and a thumbnail is small.
    buffer = await result.response().arrayBuffer();
  } catch (error) {
    // With a code: the service says it cannot. Without one, the call simply stays counted.
    if (hasCode(error)) await giveUp(c, marker, day);
    return none(reasonOf(error));
  }
  if (buffer.byteLength === 0) {
    await giveUp(c, marker, day);
    return none("empty");
  }
  if (buffer.byteLength > thumbMaxBytes(size)) {
    await giveUp(c, marker, day);
    return none("too_big");
  }

  const key = thumbKey(node.id, node.versionId, size);
  let stored: R2Object | null = null;
  try {
    stored = await store.put(key, buffer, { size: buffer.byteLength, contentType: THUMB_TYPE });
  } catch {
    stored = null;
  }
  // Written first, checked after: see the header.
  if (!(await stillCurrent(c, node))) {
    if (stored) await store.delete([key]).catch(() => {});
    return none("superseded");
  }
  return { ok: true, buffer, stored };
}

/** The node still exists, is not hidden, and is at the version that was transformed. */
async function stillCurrent(c: Context<AppEnv>, node: ThumbSource): Promise<boolean> {
  try {
    const row = await getNode(db(c), node.id);
    if (!row || row.versionId !== node.versionId) return false;
    return !(await effectiveHidden(db(c), node.id));
  } catch {
    // Unknown: the object stays (it is keyed by version), and the purge's sweep finds an orphan.
    return true;
  }
}

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
//   `thumb_unit:…`    the owner's `transform_user` unit for this thumbnail today. `bytes` = 1
//             while one request holds the right to take it (given back when the owner's ceiling
//             refuses it — no call was made, so the thumbnail keeps its day); `count` = 1 once it
//             was taken, which is final for the day. Every further call for the thumbnail that
//             day is free to the owner (the frozen `consumeCeiling` refunds no count, so a unit
//             is never taken twice instead of taken and given back). A request that finds the
//             unit held but not yet taken does not call: the owner might yet be refused, and a
//             call made meanwhile would pass the owner's ceiling.
// A request that gets neither answers "no thumbnail" at once: no unit, no call, nothing written —
// the page's next load finds the cached thumbnail or the marker. So per thumbnail per day: at
// most 3 calls and 1 unit, whoever asks, however often and however they leave; a known failure
// costs 1 call; after 3 calls without a cached result the thumbnail is the icon until 00:00 UTC.
// A new version of the file has new keys and so a fresh day; so has another size.
//
// THE CALL DOES NOT DEPEND ON THE ASKER STAYING. Once claimed, the transform and its cache write
// are handed to the request's deferred work as well as awaited: an asker who goes away
// mid-transform leaves a cached thumbnail behind.
//
// NO LOCK. Concurrent misses that hold a call each transform and each write the same bytes to
// the same key — two writers of one key are harmless.

import type { Context } from "hono";
import { THUMB_INPUT_MAX_BYTES, type ThumbSize } from "../../shared/constants";
import { addUsageIfUnder, subtractUsage, totalsOn, utcDay } from "../db/queries/ledger";
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
 * The owner's unit for this thumbnail today: taken by the one request that holds it, or already
 * taken. `false`: no call may be made now (the owner's ceiling refused it, or another request is
 * still taking it).
 */
async function ownerPaid(
  c: Context<AppEnv>,
  node: Key,
  size: ThumbSize,
  owner: ThumbOwner,
  day: string,
): Promise<"paid" | "ceiling" | "busy"> {
  const marker = unitMarker(node, size);
  // One statement: at most one request holds the unit at a time, and none once it was taken.
  const held = await addUsageIfUnder(
    db(c),
    day,
    "notice",
    marker,
    { bytes: 1, count: 0 },
    { bytes: 1, count: 0 },
  );
  if (!held) return (await totalsOn(db(c), day, "notice", marker)).count > 0 ? "paid" : "busy";
  const unit = await tryConsumeCeiling(c, "transform_user", owner, { count: 1 });
  if (!unit.ok) {
    // No call was made: the thumbnail does not lose its day to the owner's ceiling.
    try {
      await subtractUsage(db(c), day, "notice", marker, 1);
    } catch {
      // Not given back: this thumbnail waits for the next UTC day.
    }
    return "ceiling";
  }
  // Taken: final for the day. Not recorded → the thumbnail waits for the next UTC day, uncharged again.
  await addUsageIfUnder(db(c), day, "notice", marker, { bytes: 0, count: 1 }, { count: 1 }).catch(
    () => false,
  );
  return "paid";
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

  const day = utcDay(now(c));
  const paid = await ownerPaid(c, node, size, owner, day);
  if (paid !== "paid") return none(paid === "ceiling" ? "ceiling" : "unit_busy");
  const marker = failureMarker(node, size);
  if (!(await claimCall(c, marker, day))) return none("attempted_today");

  const work = attempt(c, node, size, marker, day);
  try {
    // Also the request's deferred work: it finishes — and caches — if the asker goes away.
    defer(c, work);
  } catch {
    // The request's deferred work is full: the attempt runs with the request alone.
  }
  return work;
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
      .output({ format: THUMB_TYPE, quality: QUALITY });
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

  let stored: R2Object | null = null;
  try {
    stored = await store.put(thumbKey(node.id, node.versionId, size), buffer, {
      size: buffer.byteLength,
      contentType: THUMB_TYPE,
    });
  } catch {
    stored = null;
  }
  return { ok: true, buffer, stored };
}

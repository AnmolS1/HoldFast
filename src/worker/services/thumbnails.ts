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
// ONE UNIT PER TRANSFORM, TAKEN FIRST. A miss consumes one `transform_user` unit of the file's
// OWNER before the image service is called — one atomic add-if-under, so parallel misses cannot
// pass the daily ceiling together — and a transform that then fails stays charged.
//
// A THUMBNAIL IS ATTEMPTED AT MOST THREE TIMES A DAY, AND NOT AGAIN ONCE IT IS KNOWN TO FAIL.
// Nothing is cached for a failure, and a burst of misses for one thumbnail arrives before any of
// them has finished — so without a memory every such request, by anyone holding a URL for it and
// at no cost to them, would take another unit of the owner's day and another call of the image
// service. So before the unit is taken a request CLAIMS AN ATTEMPT: one add-if-under statement on
// a marker row for (node, version, size) in the daily ledger, under the subject `notice` (rows no
// total is summed from). A request that does not get the claim answers "no thumbnail" at once:
// no unit, no call, nothing written — the page's next load finds the cached thumbnail or the
// marker.
//   `bytes`   attempts HELD today, at most THUMB_ATTEMPTS_PER_DAY. An attempt is given back
//             when it is not the image that failed: the thumbnail was made (whether or not the
//             cache write then worked), or the owner's unit could not be taken. It stays used
//             when the image service failed WITHOUT a code (a lost connection — which is also
//             how the service answers an oversize input: the two cannot be told apart).
//   `count`   1 once it is known that this thumbnail cannot be made today: a failure the service
//             gave a CODE for (its quota, an input it cannot decode), an empty output, a missing
//             source object. The claim's own ceiling refuses every attempt after that.
// So: at most three transforms of one thumbnail are in flight at once, however many ask; a
// known failure costs its owner one unit and one call a day (three in a burst), a failure
// without a code three; a thumbnail that can be made is never held back by its marker. A new
// version of the file has a new key and so fresh attempts; so has another size; so has the next
// UTC day.
//
// THE ATTEMPT DOES NOT DEPEND ON THE ASKER STAYING. Once claimed, the transform and its cache
// write are handed to the request's deferred work as well as awaited: an asker who goes away
// mid-transform leaves a cached thumbnail behind, not a used-up attempt.
//
// NO LOCK. Concurrent misses that hold a claim each transform and each write the same bytes to
// the same key — two writers of one key are harmless.

import type { Context } from "hono";
import { THUMB_INPUT_MAX_BYTES, type ThumbSize } from "../../shared/constants";
import { addUsageIfUnder, subtractUsage, utcDay } from "../db/queries/ledger";
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

/** How many attempts a day one thumbnail — one size of one version of a file — gets. */
export const THUMB_ATTEMPTS_PER_DAY = 3;

/** The id of a thumbnail's attempt marker (ledger subject `notice`). */
export function failureMarker(node: Pick<ThumbSource, "id" | "versionId">, size: ThumbSize): string {
  return `thumb_failed:${node.id}:${node.versionId}:${size}`;
}

const hasCode = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" || (typeof code === "string" && /^\d{1,6}$/.test(code));
};

/**
 * Claims one of today's attempts: true while fewer than THUMB_ATTEMPTS_PER_DAY are held, and
 * never once the thumbnail was given up on. One statement, so any number of requests at once get
 * at most that many claims between them.
 */
function claimAttempt(c: Context<AppEnv>, marker: string, day: string): Promise<boolean> {
  return addUsageIfUnder(
    db(c),
    day,
    "notice",
    marker,
    { bytes: 1, count: 0 },
    { bytes: THUMB_ATTEMPTS_PER_DAY, count: 0 },
  );
}

/** Gives an attempt back: it ended for a reason that says nothing against the image. Never throws. */
async function release(c: Context<AppEnv>, marker: string, day: string): Promise<void> {
  try {
    await subtractUsage(db(c), day, "notice", marker, 1);
  } catch {
    // Not given back: one attempt fewer today.
  }
}

/** No further attempt today. Never throws: the answer is a 404 either way. */
async function giveUp(c: Context<AppEnv>, marker: string, day: string): Promise<void> {
  try {
    await addUsageIfUnder(db(c), day, "notice", marker, { bytes: 0, count: 1 }, { count: 1 });
  } catch {
    // Not recorded: the attempts that are left may still be used.
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

  // An attempt of today's, claimed before anything is spent. Not got: the same answer, at once.
  const marker = failureMarker(node, size);
  const day = utcDay(now(c));
  if (!(await claimAttempt(c, marker, day))) return none("attempted_today");

  const unit = await tryConsumeCeiling(c, "transform_user", owner, { count: 1 });
  if (!unit.ok) {
    // Nothing was asked of the image service: the attempt is not the thumbnail's to lose.
    await release(c, marker, day);
    return none("ceiling");
  }

  const work = attempt(c, node, size, marker, day);
  try {
    // Also the request's deferred work: it finishes — and caches — if the asker goes away.
    defer(c, work);
  } catch {
    // The request's deferred work is full: the attempt runs with the request alone.
  }
  return work;
}

/** The transform and its cache write, with what becomes of the claim. Never rejects. */
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
    // With a code: the service says it cannot. Without one, the attempt simply stays used.
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
  // Made: whatever became of the cache write, nothing is held against this thumbnail.
  await release(c, marker, day);
  return { ok: true, buffer, stored };
}

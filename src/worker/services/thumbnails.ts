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
// A THUMBNAIL THAT FAILED TODAY IS NOT TRIED AGAIN TODAY. Nothing is cached for a failure, so
// without a memory of it every request for that thumbnail — by anyone holding a URL for it, at
// no cost to them — would take another unit of the owner's day and another call of the image
// service. So a failure leaves a marker for (node, version, size) in the daily ledger, under the
// subject `notice` (rows no total is summed from), and a miss that finds it answers "no
// thumbnail" at once: no unit, no call, nothing written.
//   a failure the service gave a CODE for (its quota, an input it cannot decode), an empty
//   output, a missing source object           → `count` 1: ONE unit and ONE call that day
//   a failure WITHOUT a code (a lost connection — which is also how the service answers an
//   oversize input: the two cannot be told apart) → `bytes` + 1, and no more tries at
//   UNCODED_TRIES: at most three units and three calls that day
// A new version of the file has a new key and so a fresh attempt; so has another size; so has the
// next UTC day. A transform that succeeded never has a marker — it has a cached object.
//
// NO LOCK. Two concurrent misses both transform and both write the same bytes to the same key
// (and when both fail, both claim the one marker).

import type { Context } from "hono";
import { THUMB_INPUT_MAX_BYTES, type ThumbSize } from "../../shared/constants";
import { addUsageIfUnder, totalsOn, utcDay } from "../db/queries/ledger";
import { tryConsumeCeiling } from "./ceilings";
import { now } from "./clock";
import { db, type AppEnv } from "./request-context";
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

/** How often a day a thumbnail is tried again after a failure that carried no code. */
export const UNCODED_TRIES = 3;

/** The id of a thumbnail's failure marker (ledger subject `notice`). */
export function failureMarker(node: Pick<ThumbSource, "id" | "versionId">, size: ThumbSize): string {
  return `thumb_failed:${node.id}:${node.versionId}:${size}`;
}

const hasCode = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" || (typeof code === "string" && /^\d{1,6}$/.test(code));
};

/** Remembers a failure for the rest of the UTC day. Never throws: the answer is a 404 either way. */
async function remember(c: Context<AppEnv>, marker: string, day: string, final: boolean): Promise<void> {
  try {
    await addUsageIfUnder(
      db(c),
      day,
      "notice",
      marker,
      final ? { bytes: 0, count: 1 } : { bytes: 1, count: 0 },
      final ? { count: 1 } : { bytes: UNCODED_TRIES },
    );
  } catch {
    // Not remembered: the next request tries once more.
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

  // Failed today already: the same answer, and nothing is spent on it.
  const marker = failureMarker(node, size);
  const day = utcDay(now(c));
  const failed = await totalsOn(db(c), day, "notice", marker);
  if (failed.count >= 1 || failed.bytes >= UNCODED_TRIES) return none("failed_today");

  const unit = await tryConsumeCeiling(c, "transform_user", owner, { count: 1 });
  if (!unit.ok) return none("ceiling");

  const store = storage(c.env);
  let buffer: ArrayBuffer;
  try {
    const source = await store.get(node.r2Key);
    if (!source || source.kind !== "body") {
      await remember(c, marker, day, true);
      return none("no_source");
    }
    const result = await c.env.IMAGES.input(source.object.body)
      .transform({ width: size, height: size, fit: "scale-down" })
      .output({ format: THUMB_TYPE, quality: QUALITY });
    // Read whole: the store takes no stream of unknown length, and a thumbnail is small.
    buffer = await result.response().arrayBuffer();
  } catch (error) {
    await remember(c, marker, day, hasCode(error));
    return none(reasonOf(error));
  }
  if (buffer.byteLength === 0) {
    await remember(c, marker, day, true);
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

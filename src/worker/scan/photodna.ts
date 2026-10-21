// PhotoDNA (Microsoft's Cloud Service `Match` API) for the scan consumer. OFF IN v1: it runs only
// when `PHOTODNA_ENABLED === 'true'`, and that flag is not set anywhere until the application is
// approved and the 72-hour reporting commitment is settled (task step 4; legal/photodna-checklist.md
// §2; T29 §C.3). This build calls only `Match`: a match locks the node and the operator files with
// NCMEC by hand — there is no call to Microsoft's reporting API and no 72-hour clock.
//
// IMAGES ONLY (`mimeSniffed` starts with `image/`): the service covers nothing else. Formats it
// does not take are skipped, not converted.
//
// WHERE AN ERROR WAS THROWN DECIDES WHAT IT IS — never its message (spike S13: the deployed Images
// binding answers an input above 20 MB with a plain `Error("Network connection lost.")`):
//   - anything thrown by `env.IMAGES` → PhotoDNA is SKIPPED for this object (`skipped:images`,
//     `skipped:images_9422` for the quota error) — the scan goes on, nothing is retried;
//   - an object above `THUMB_INPUT_MAX_BYTES` never reaches the binding (`skipped:size`);
//   - a network error or ANY answer from the PhotoDNA request but a 200 with a success status —
//     401/403 (an auth or config failure), 429, 5xx, any other 4xx, a status code that is not
//     success → `PhotoDnaTransientError`: the consumer fails the job and retries the message, and
//     a failure that persists ends `error` through the dead-letter queue (ruling, Addendum 2);
//   - "cannot be checked" for a SIZE or IMAGES limit (`size`, `images`, `images_9422`) — and a
//     format the service does not take (`format`, task step 4) — is recorded in
//     `scanDetail.photodna` and does not hold back the engine's verdict.
// Each downscale is an Images transformation: one `transform_user` unit is added to the ledger for
// the owner, the subject T13's thumbnails use, so the Images alarm counts it (T27).
//
// The request shape and limits below are from Microsoft's PhotoDNA Cloud Service documentation and
// must be checked against the portal's API reference when the subscription exists (T29).

import { THUMB_INPUT_MAX_BYTES } from "../../shared/constants";
import { addUsage, utcDay } from "../db/queries/ledger";
import type { ServiceDeps } from "../services/request-context";
import { storage } from "../services/storage";

export const PHOTODNA_MATCH_URL = "https://api.microsoftmoderator.com/photodna/v1.0/Match";
/** The largest image the Match API takes; anything larger is downscaled through Images first. */
export const PHOTODNA_MAX_BYTES = 4_000_000;
/** The long side a downscaled image is given. */
export const PHOTODNA_DOWNSCALE_PX = 2_048;
/** The Match API's "OK" status code. */
const PHOTODNA_OK = 3000;
/** The formats the Match API takes as they are. */
const PHOTODNA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/bmp", "image/tiff"]);
/** The Images error code for "the account's transformation quota is used up" (decision D2). */
const IMAGES_QUOTA_CODE = 9422;

/** The PhotoDNA request failed in a way another attempt may not: retry the message. */
export class PhotoDnaTransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PhotoDnaTransientError";
  }
}

/** `match` / `no_match` when PhotoDNA answered; `skipped` with the note for `scanDetail.photodna`. */
export type PhotoDnaResult = { match: boolean } | { skipped: string };

/** Test seams; production passes nothing. */
export type PhotoDnaIo = { fetch?: typeof fetch };

export function photodnaEnabled(env: Pick<Env, "PHOTODNA_ENABLED">): boolean {
  return env.PHOTODNA_ENABLED === "true";
}

/** What `scanDetail.photodna` records for a result. */
export function photodnaNote(result: PhotoDnaResult): string {
  return "skipped" in result ? `skipped:${result.skipped}` : result.match ? "match" : "no_match";
}

const codeOf = (error: unknown): number | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
};

/**
 * Checks one stored image. Null when PhotoDNA does not run for it (flag off, not an image).
 * Throws only `PhotoDnaTransientError` (and a storage failure, which the consumer retries).
 */
export async function checkPhotoDna(
  deps: Pick<ServiceDeps, "env" | "db">,
  object: { key: string; size: number; mimeSniffed: string; ownerId: string },
  io: PhotoDnaIo = {},
): Promise<PhotoDnaResult | null> {
  if (!photodnaEnabled(deps.env) || !object.mimeSniffed.startsWith("image/")) return null;
  const subscriptionKey = deps.env.PHOTODNA_SUBSCRIPTION_KEY;
  // Switched on without its key: fail closed — retried, and in the end `error`, never unchecked.
  if (!subscriptionKey) throw new PhotoDnaTransientError("photodna: enabled without a subscription key");
  if (!PHOTODNA_TYPES.has(object.mimeSniffed)) return { skipped: "format" };
  if (object.size > THUMB_INPUT_MAX_BYTES) return { skipped: "size" };

  const read = await storage(deps.env).get(object.key);
  if (read?.kind !== "body") throw new Error("photodna: the object is gone");
  let image: ArrayBuffer;
  let contentType = object.mimeSniffed;
  if (object.size > PHOTODNA_MAX_BYTES) {
    try {
      const result = await deps.env.IMAGES.input(read.object.body)
        .transform({ width: PHOTODNA_DOWNSCALE_PX, height: PHOTODNA_DOWNSCALE_PX, fit: "scale-down" })
        .output({ format: "image/jpeg" });
      image = await result.response().arrayBuffer();
    } catch (error) {
      return { skipped: codeOf(error) === IMAGES_QUOTA_CODE ? "images_9422" : "images" };
    }
    contentType = "image/jpeg";
    await addUsage(deps.db, utcDay(), "transform_user", object.ownerId, 0, 1);
    if (image.byteLength === 0 || image.byteLength > PHOTODNA_MAX_BYTES) return { skipped: "images" };
  } else {
    image = await read.object.arrayBuffer();
  }

  let response: Response;
  try {
    response = await (io.fetch ?? fetch)(PHOTODNA_MATCH_URL, {
      method: "POST",
      headers: { "Content-Type": contentType, "Ocp-Apim-Subscription-Key": subscriptionKey },
      body: image,
    });
  } catch (error) {
    throw new PhotoDnaTransientError("photodna: the request failed", { cause: error });
  }
  // Every answer but a 200 — 401/403 (the key), 429, 5xx, any other — is a failure to CHECK:
  // retried, and in the end `error` — never "skipped" (Addendum 2).
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new PhotoDnaTransientError(`photodna: answered ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as {
    Status?: { Code?: unknown };
    IsMatch?: unknown;
  } | null;
  if (body?.Status?.Code !== PHOTODNA_OK || typeof body.IsMatch !== "boolean") {
    // Not an answer to "does it match": the same as no answer.
    throw new PhotoDnaTransientError(
      `photodna: status ${typeof body?.Status?.Code === "number" ? body.Status.Code : "unknown"}`,
    );
  }
  return { match: body.IsMatch };
}

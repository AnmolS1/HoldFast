// The scan queue's consumer — the STUB one. It exists so that files can leave `pending` before
// the real scan pipeline lands; that pipeline replaces this file's body and keeps its behaviour
// for everything below except the verdict itself.
//
// `queue(batch, env, ctx, bg)`: the Worker entry calls it inside `runBackground`. `bg` is the
// run's context — `bg.db`, `bg.defer`, `bg.metric` — and this file opens no client of its own.
//
// PER MESSAGE
//  1. `normalizeScanMessage`. Not a scan message, or a key outside `u/`: acknowledged and logged.
//  2. FAIL CLOSED. Unless the stub is enabled (`SCAN_STUB=1` and not production) the message is
//     retried in five minutes and nothing else happens: a deploy without a scanner leaves files
//     `pending`. This rule is the only thing between a misconfigured deploy and unscanned files
//     being served.
//  3. Resolve the key to a node. NO NODE IS THE NORMAL CASE, not an error: the object store sends
//     its own event before the upload's request has inserted the node.
//        an upload session with this key is open or completing   → retry in 10 s
//        the key is a superseded version                         → acknowledge
//        nothing references the key                              → retry in 10 s twice, then acknowledge
//     Nothing is ever deleted here; unreferenced objects are the orphan sweep's.
//  4. Claim the scan job (keyed on the object key). Finished already → acknowledge; another
//     delivery is running it → retry.
//  5. Read the object: detect its type from the first 8,192 bytes, scan the body.
//  6. In one transaction, with the node's row locked: write the verdict ONLY IF THE NODE IS STILL
//     `pending` AND NOT TAKEN DOWN; in every case finish the job. Then acknowledge.
//     A node in any other state is left exactly as it is — every column. The store notifies for
//     every completed object, including one the upload route has just locked as suspected CSAM,
//     and this consumer must never turn that node `clean`. (The verdict writer itself is not a
//     passive guard: handed an `under_review` node it would store the verdict as the status to
//     restore. So for such a node it is simply not called.)
//  A failure anywhere after the claim marks the job failed — claimable again — and retries.
//
// No side effects beyond the status: no email, strike, blocklist entry or link change, and no
// hash check. Those belong to the real pipeline.

import { findByR2Key, keyReference, setScanResult } from "../db/queries/nodes";
import { claim, finish, type ClaimResult } from "../db/queries/scan-jobs";
import { captureError } from "../sentry";
import { sniff, SNIFF_PREFIX_BYTES } from "../services/mime";
import type { BackgroundContext } from "../services/request-context";
import { getScanner, normalizeScanMessage, stubEnabled, type ScanMessage } from "../services/scanning";
import { storage } from "../services/storage";

/** A deploy without a scanner looks again this often. */
export const FAIL_CLOSED_RETRY_SEC = 300;
/** How long to wait for the upload's request to insert the node, or for another delivery to finish. */
export const NO_NODE_RETRY_SEC = 10;
export const RUNNING_RETRY_SEC = 30;
/** A key nothing references is given up on at this delivery attempt. */
export const UNKNOWN_KEY_MAX_ATTEMPTS = 3;

type Claimed = Extract<ClaimResult, { claimed: true }>;

/** A key (ids only, never a secret) made safe for one log line. */
function loggable(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  return typeof value === "string" ? value.slice(0, 200).replace(/[\u0000-\u001f\u007f]/g, "?") : "(no key)";
}

function keyOf(body: unknown): unknown {
  if (body === null || typeof body !== "object") return undefined;
  const record = body as { key?: unknown; object?: { key?: unknown } | null };
  return record.key ?? record.object?.key;
}

async function readPrefix(env: Env, key: string, size: number): Promise<Uint8Array> {
  if (size === 0) return new Uint8Array(0);
  const head = await storage(env).get(key, {
    range: { offset: 0, length: Math.min(size, SNIFF_PREFIX_BYTES) },
  });
  if (!head || !("body" in head)) throw new Error("scan: the object is gone");
  return new Uint8Array(await head.arrayBuffer());
}

/** Steps 5 and 6 for a claimed job. */
async function scanClaimed(
  env: Env,
  bg: BackgroundContext,
  scan: ScanMessage,
  name: string,
  claimed: Claimed,
): Promise<string> {
  const store = storage(env);
  const head = await store.head(scan.key);
  if (!head) throw new Error("scan: the object is gone");
  // Awaited: the detector is asynchronous, and a Promise must never be stored as a type.
  const mimeSniffed = await sniff(await readPrefix(env, scan.key, head.size), name);
  const object = await store.get(scan.key);
  if (!object || !("body" in object)) throw new Error("scan: the object is gone");
  const verdict = await getScanner(env).scanStream(object.body, { key: scan.key, size: object.size });

  return bg.db.transaction(async (tx) => {
    const node = await findByR2Key(tx, scan.key, { forUpdate: true });
    let outcome = "left";
    // The guard. `setScanResult` writes what it is given, so it is not called for any other node.
    if (node && node.scanStatus === "pending" && node.takedownAt === null) {
      await setScanResult(tx, node.id, scan.key, {
        scanStatus: verdict.status,
        scanReason: verdict.reason ?? null,
        scanDetail: {
          engine: verdict.engine,
          ...(verdict.signatures.length > 0 ? { signatures: verdict.signatures } : {}),
        },
        mimeSniffed,
        scannedAt: new Date(),
      });
      outcome = verdict.status;
    }
    await finish(tx, claimed, "done", { ...verdict });
    return outcome;
  });
}

async function handle(message: Message<unknown>, env: Env, bg: BackgroundContext): Promise<void> {
  const scan = normalizeScanMessage(message.body);
  if (!scan) {
    console.warn(
      `scan: message ignored (not a scan message, or a key outside u/): ${loggable(keyOf(message.body))}`,
    );
    message.ack();
    return;
  }

  if (!stubEnabled(env)) {
    message.retry({ delaySeconds: FAIL_CLOSED_RETRY_SEC });
    return;
  }

  const node = await findByR2Key(bg.db, scan.key);
  if (!node) {
    const reference = await keyReference(bg.db, scan.key);
    if (reference?.kind === "version") {
      message.ack();
    } else if (reference !== null || message.attempts < UNKNOWN_KEY_MAX_ATTEMPTS) {
      // An upload session that is still open or completing — or the first sightings of a key
      // nothing references yet.
      message.retry({ delaySeconds: NO_NODE_RETRY_SEC });
    } else {
      console.warn(`scan: nothing references the key, given up: ${loggable(scan.key)}`);
      message.ack();
    }
    return;
  }
  if (scan.nodeId !== undefined && scan.nodeId !== node.id) {
    console.warn(`scan: the message names another node than the key's, ignored: ${loggable(scan.key)}`);
    message.ack();
    return;
  }

  const claimed = await claim(bg.db, {
    nodeId: node.id,
    r2Key: scan.key,
    etag: scan.etag,
    force: scan.force,
  });
  if (!claimed.claimed) {
    if (claimed.status === "done") message.ack();
    else message.retry({ delaySeconds: RUNNING_RETRY_SEC });
    return;
  }

  try {
    const outcome = await scanClaimed(env, bg, scan, node.name, claimed);
    bg.metric("scan", { outcome, kind: "stub" });
    message.ack();
  } catch (error) {
    captureError(error, { kind: "scan" });
    bg.metric("scan", { outcome: "failed", kind: "stub" });
    await finish(
      bg.db,
      claimed,
      "failed",
      null,
      error instanceof Error ? error.message.slice(0, 200) : "failed",
    );
    message.retry();
  }
}

export async function queue(
  batch: MessageBatch<unknown>,
  env: Env,
  ctx: ExecutionContext,
  bg: BackgroundContext,
): Promise<void> {
  void ctx;
  // Dead letters: nothing more can be done with them here.
  if (batch.queue.endsWith("-dlq")) {
    for (const message of batch.messages) {
      console.warn(`scan: dead-lettered message acknowledged: ${loggable(keyOf(message.body))}`);
      message.ack();
    }
    return;
  }
  // A batch with no scan message in it at all is acknowledged whole.
  if (batch.messages.every((message) => normalizeScanMessage(message.body) === null)) {
    for (const message of batch.messages) {
      console.warn(
        `scan: message ignored (not a scan message, or a key outside u/): ${loggable(keyOf(message.body))}`,
      );
    }
    batch.ackAll();
    return;
  }
  for (const message of batch.messages) {
    try {
      await handle(message, env, bg);
    } catch (error) {
      // Before the claim (a database error, say): nothing to mark, try again.
      captureError(error, { kind: "scan" });
      message.retry();
    }
  }
}

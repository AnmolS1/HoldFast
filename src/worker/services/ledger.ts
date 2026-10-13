// What a response of the files host costs, and who is told when a link runs out.
//
//   recordServe(c, serve)                 gate 5: charges the body bytes of ONE response to every
//                                         daily ledger it counts on, BEFORE the first byte is sent
//   settleServe(deps, charge, sent)       after the stream ended: gives the unsent bytes back and
//                                         adds the sent ones to the link
//   refundOthers(deps, charge)            a charged request that serves nothing after all gives
//                                         back what it took from the owner's cap and the link
//   notifyLinkLimitOnce(deps, linkId)    the "this link reached today's limit" mail, once a day
//   notifyOwnerLinkCapOnce(deps, owner)   the "your links reached today's limit" mail, once a day
//   notifyLinkPausedOnce(deps, id, why)   the "link paused" mail, at most once a day per link —
//                                         for whoever really pauses a link; this host never does
//
// CHARGED UP FRONT, NEVER CHECKED THEN RECORDED. Every ledger is consumed with the ceilings
// service's atomic add-if-under, in this order, and the first refusal decides:
//   a signed-in subject   download_ip → download_user
//   a link subject        download_ip → download_owner → download_link
// THE ASKER'S OWN CHARGE STAYS when a later ledger refuses: the address pays for a request the
// owner's cap or the link's ceiling then refuses, and an address over its own ceiling writes
// nothing at all — so it cannot spend a link's or an owner's day. What the request charged to
// SOMEONE ELSE's budget does not stay: it is given back at once (`refundOthers`).
// BYTES ONLY. No count is consumed here (the per-link download count belongs to the mint), and a
// response without a body — 304, 412, 416, HEAD — is not charged and writes no row.
//
// A CEILING NEVER PAUSES A LINK. A refused `download_owner` or `download_link` consume is a 429
// for as long as that ledger is full — every link of the owner, or the one link — and is served
// again as soon as there is room: a refund, or the day rolling over. Charges are reservations
// (a download that was opened and not read holds its bytes until it ends), so a pause on a full
// ledger would let anyone pause a link that had served nothing. The owner is told once that day:
// one mail per owner for the cap, one per link for its limit.

import type { Context } from "hono";
import { addBytesServed, accountOf, claimPauseEmail, type ServeAccount } from "../db/queries/files-host";
import { addUsageIfUnder, utcDay } from "../db/queries/ledger";
import { getById as linkById } from "../db/queries/links";
import { getNode } from "../db/queries/nodes";
import type { PauseReason } from "../db/schema";
import {
  ceilingExceeded,
  consumeCeiling,
  refundUsage,
  tryConsumeCeiling,
  type ConsumeReceipt,
} from "./ceilings";
import { now } from "./clock";
import { sendLinkCapReached, sendLinkLimitReached, sendLinkPaused } from "./email";
import { metric } from "./metrics";
import { deps, type AppEnv, type ServiceDeps } from "./request-context";

type DownloadKind = "download_ip" | "download_user" | "download_owner" | "download_link";

/** One ledger this response was charged on, with the receipt its refund needs. */
export type Charge = { kind: DownloadKind; subjectId: string; receipt: ConsumeReceipt };

/** What `recordServe` charged: the bytes, each ledger, and the link the bytes are served through. */
export type ServeCharge = { bytes: number; charges: Charge[]; linkId: string | null };

type Account = Pick<ServeAccount, "quotaBytes" | "createdAt">;

export type Serve = {
  /** The body bytes this response will send: the full size, or the length of the range. */
  bytes: number;
  /** The client address as its daily hash — the `download_ip` subject. */
  ip: string;
} & (
  | { st: "u"; sub: string; account: Account }
  | { st: "l"; sub: string; owner: { id: string; account: Account } }
);

/**
 * Gate 5. Charges `serve.bytes` to every ledger of the subject, or throws `429 ceiling_exceeded`
 * (`Retry-After` to 00:00 UTC) at the first one that refuses. Nothing is refunded here: what an
 * earlier ledger was charged stays. Zero bytes: no call, no row, an empty charge.
 */
export async function recordServe(c: Context<AppEnv>, serve: Serve): Promise<ServeCharge> {
  const { bytes } = serve;
  const linkId = serve.st === "l" ? serve.sub : null;
  const charges: Charge[] = [];
  if (bytes === 0) return { bytes, charges, linkId };

  try {
    const address = await consumeCeiling(c, "download_ip", { id: serve.ip }, { bytes });
    charges.push({ kind: "download_ip", subjectId: serve.ip, receipt: address });

    if (serve.st === "u") {
      const subject = { id: serve.sub, account: serve.account };
      const mine = await consumeCeiling(c, "download_user", subject, { bytes });
      charges.push({ kind: "download_user", subjectId: serve.sub, receipt: mine });
      return { bytes, charges, linkId };
    }

    const owner = { id: serve.owner.id, account: serve.owner.account };
    const owned = await tryConsumeCeiling(c, "download_owner", owner, { bytes });
    if (!owned.ok) {
      await told(() => notifyOwnerLinkCapOnce(deps(c), serve.owner.id, now(c)));
      throw ceilingExceeded(owned);
    }
    charges.push({ kind: "download_owner", subjectId: serve.owner.id, receipt: { day: owned.day } });

    // The link's ceiling scales with its OWNER's account (the new-account factor).
    const linked = await tryConsumeCeiling(
      c,
      "download_link",
      { id: serve.sub, account: serve.owner.account },
      { bytes },
    );
    if (!linked.ok) {
      await told(() => notifyLinkLimitOnce(deps(c), serve.sub, now(c)));
      throw ceilingExceeded(linked);
    }
    charges.push({ kind: "download_link", subjectId: serve.sub, receipt: { day: linked.day } });
    return { bytes, charges, linkId };
  } catch (error) {
    // Refused by a later ledger, or failed: nothing of this request will be sent.
    await refundOthers(deps(c), { bytes, charges, linkId });
    throw error;
  }
}

/**
 * A request that was charged and then serves NOTHING — a later ledger refused it, or something
 * failed before its first byte — gives back at once what it charged to SOMEONE ELSE's budget:
 * the owner's cap and the link. With no pause to end them, refusals at a full link would
 * otherwise each take a file's size of the owner's day at no cost in transfer.
 * The asker's own charges stay — the address's, and a signed-in user's: that is what bounds
 * hammering from one address. A refund that fails is logged and dropped.
 */
export async function refundOthers(source: ServiceDeps, charge: ServeCharge): Promise<void> {
  for (const { kind, subjectId, receipt } of charge.charges) {
    if (kind !== "download_owner" && kind !== "download_link") continue;
    await told(() => refundUsage(source, kind, subjectId, { bytes: charge.bytes }, receipt));
  }
}

/** A consequence of a refusal must never replace the refusal: its failure is logged and dropped. */
async function told(act: () => Promise<unknown>): Promise<void> {
  try {
    await act();
  } catch {
    metric("ceiling", { outcome: "error", reason: "notice" });
    console.warn("files host: the consequence of a ceiling refusal failed");
  }
}

/**
 * After the response's stream ended or was cancelled, having sent `sent` body bytes: every ledger
 * the request was charged on gets `charge.bytes − sent` back (the same UTC day only — a refund
 * for a charge of an earlier day is dropped where it is applied), and the link's `bytesServed`
 * grows by what was sent. A refund that fails is logged and dropped: the requester stays charged.
 */
export async function settleServe(source: ServiceDeps, charge: ServeCharge, sent: number): Promise<void> {
  // A count that is not one (never seen; a bug if it is) refunds nothing: the charge stands.
  const counted = Number.isSafeInteger(sent) && sent >= 0;
  const delivered = counted ? Math.min(sent, charge.bytes) : charge.bytes;
  const unsent = charge.bytes - delivered;
  if (unsent > 0) {
    for (const { kind, subjectId, receipt } of charge.charges) {
      try {
        await refundUsage(source, kind, subjectId, { bytes: unsent }, receipt);
      } catch {
        metric("ceiling", { kind, outcome: "error", reason: "refund" });
        console.warn(`files host: a refund failed and was dropped (${kind})`);
      }
    }
  }
  if (charge.linkId !== null && counted && delivered > 0) {
    try {
      await addBytesServed(source.db, charge.linkId, delivered);
    } catch {
      metric("link", { outcome: "error", reason: "bytes_served" });
      console.warn("files host: a link's served bytes were not recorded");
    }
  }
}

/**
 * The "link paused" mail to the link's owner, at most once per link per UTC day: claims the
 * day's stamp atomically (two concurrent calls → one claim) and queues the mail only when it won.
 * True when a mail was queued. `reason` is why the link was paused; the stamp is one per link
 * whatever the reason. Takes `ServiceDeps`: it is for the code that really pauses a link (a
 * report, an admin, the deletion window). A full ledger is not a pause — see the header.
 */
export async function notifyLinkPausedOnce(
  source: ServiceDeps,
  linkId: string,
  reason: PauseReason,
): Promise<boolean> {
  const claimed = await claimPauseEmail(source.db, linkId);
  if (!claimed) return false;
  const [owner, node] = await Promise.all([
    accountOf(source.db, claimed.ownerId),
    getNode(source.db, claimed.nodeId),
  ]);
  if (!owner || !node) return false;
  source.defer(sendLinkPaused(source, { to: owner.email, name: owner.name, itemName: node.name }));
  metric("link", { outcome: "paused_notice", reason });
  return true;
}

/**
 * Claims a once-a-day notice: a marker row in the daily ledger under the subject `notice` — never
 * among the rows a byte total is summed from — added only if none exists for that day. One
 * statement, so of any number of concurrent calls exactly one wins.
 */
function claimNotice(source: ServiceDeps, key: string, at: Date): Promise<boolean> {
  return addUsageIfUnder(source.db, utcDay(at), "notice", key, { bytes: 0, count: 1 }, { count: 1 });
}

/**
 * The "this link reached today's limit — it comes back on its own" mail to the link's owner,
 * once per link per UTC day, whichever limit of the link was reached: this host calls it when the
 * link's BYTES run out, the mint when its download COUNT does — together they send one mail.
 * True when a mail was queued. `at` decides which day it is (real time by default).
 */
export async function notifyLinkLimitOnce(
  source: ServiceDeps,
  linkId: string,
  at: Date = new Date(),
): Promise<boolean> {
  const link = await linkById(source.db, linkId);
  if (!link) return false;
  if (!(await claimNotice(source, `download_link:${link.id}`, at))) return false;
  const [owner, node] = await Promise.all([
    accountOf(source.db, link.createdBy),
    getNode(source.db, link.nodeId),
  ]);
  if (!owner || !node) return false;
  source.defer(sendLinkLimitReached(source, { to: owner.email, name: owner.name, itemName: node.name }));
  return true;
}

/**
 * The "your links reached today's transfer limit" mail, once per owner per UTC day (the marker is
 * never among the `link_owner` rows a byte total is summed from). True when a mail was queued.
 * `at` decides which day it is (the request's clock; real time by default).
 */
export async function notifyOwnerLinkCapOnce(
  source: ServiceDeps,
  ownerId: string,
  at: Date = new Date(),
): Promise<boolean> {
  const won = await claimNotice(source, `download_owner:${ownerId}`, at);
  if (!won) return false;
  const owner = await accountOf(source.db, ownerId);
  if (!owner) return false;
  source.defer(sendLinkCapReached(source, { to: owner.email, name: owner.name }));
  return true;
}

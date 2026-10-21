// The midnight lift of `anomaly` pauses (cron 5 0 * * *).
//
// ONE REASON: `anomaly` — taken off every link that carries it, except a link an admin locked
// (`unpauseLinks({ all: true }, "anomaly")`, T05). Every other reason stays: a report, a
// moderation action, the owner's own pause, an owner's deletion or suspension. Pauses are a SET,
// so a link paused for `anomaly` and `report` stays paused, for `report`. A daily ceiling never
// pauses a link (ruling 2026-10-13: the mint and the files host answer 429 while the ledger is
// full and write no reason), so there is no `ceiling` pause to lift; a stored `ceiling` is left
// as it is.
//
// The owner of a link that is LIVE again (no reason left) gets one "link available again" mail
// a day, whatever the number of their links (a `notice` ledger marker, claimed before sending).
// The owner cannot lift an `anomaly` pause themselves: an admin or this job does.

import { availableAgainRecipients } from "../db/queries/abuse";
import { addUsageIfUnder, utcDay } from "../db/queries/ledger";
import { unpauseLinks } from "../db/queries/links";
import { captureError } from "../sentry";
import { sendLinkAvailableAgain } from "../services/email";
import type { Job } from "./index";

/** The day's "told that a link is available again" marker of one owner (ledger subject `notice`). */
export const availableAgainMarker = (ownerId: string) => `link_available:${ownerId}`;

export const job: Job = {
  name: "unpause-midnight",
  cron: "5 0 * * *",
  async run(bg) {
    const lifted = await unpauseLinks(bg.db, { all: true }, "anomaly");
    bg.metric("job", { kind: "unpause-midnight", outcome: "ok", reason: "anomaly" }, lifted.length);

    // Live again, by owner, in the order the links came back.
    const byOwner = new Map<string, string[]>();
    for (const link of lifted) {
      if (!link.nowLive) continue;
      byOwner.set(link.ownerId, [...(byOwner.get(link.ownerId) ?? []), link.nodeId]);
    }
    if (byOwner.size === 0) return;
    const day = utcDay(new Date());
    const recipients = await availableAgainRecipients(
      bg.db,
      [...byOwner].map(([ownerId, nodeIds]) => ({ ownerId, nodeIds })),
    );
    for (const owner of recipients) {
      try {
        const once = await addUsageIfUnder(
          bg.db,
          day,
          "notice",
          availableAgainMarker(owner.ownerId),
          { bytes: 0, count: 1 },
          { count: 1 },
        );
        if (!once) continue;
        const outcome = await sendLinkAvailableAgain(bg, {
          to: owner.email,
          name: owner.name,
          itemName: owner.itemName,
        });
        bg.metric("job", { kind: "unpause-midnight", outcome: "mailed", reason: String(outcome) });
      } catch (error) {
        // One owner's mail must not stop the next one's.
        captureError(error, { kind: "job", job: "unpause-midnight" });
        bg.metric("job", { kind: "unpause-midnight", outcome: "error", reason: "mail" });
      }
    }
  },
};

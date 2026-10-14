// The queue as the transfer ribbon shows it: one fraction, one sentence in user units, one status.
import type { RibbonState } from "../../components/TransferRibbon";
import { formatBytes } from "../../lib/format";
import { isRestored, type PauseReason, type UploadItem, type UploadSnapshot } from "./store";
import { t } from "./strings";

/** "40 s", "3 min", "2 h". */
export function formatEta(seconds: number): string {
  if (seconds < 60) return t("eta.seconds", { n: Math.max(1, Math.round(seconds)) });
  if (seconds < 3600) return t("eta.minutes", { n: Math.round(seconds / 60) });
  return t("eta.hours", { n: Math.round(seconds / 3600) });
}

const counted = (one: Parameters<typeof t>[0], other: Parameters<typeof t>[0], count: number): string =>
  count === 1 ? t(one) : t(other, { count });

const PAUSE_SENTENCE: Record<Exclude<PauseReason, "user">, Parameters<typeof t>[0]> = {
  offline: "ribbon.offline",
  auth: "ribbon.auth",
  ceiling: "ribbon.ceiling",
  disabled: "ribbon.disabled",
  limited: "ribbon.limited",
  open: "ribbon.open",
};

const isBlocked = (item: UploadItem) => item.state === "done" && item.scanStatus === "infected";
const isUnscanned = (item: UploadItem) =>
  item.state === "done" && (item.scanStatus === "error" || item.scanStatus === "skipped");
const isSending = (item: UploadItem) =>
  item.state === "queued" ||
  item.state === "uploading" ||
  item.state === "hashing" ||
  item.state === "completing";

/** What the ribbon shows for the queue, or null when the queue has nothing to say. */
export function summarise(snapshot: UploadSnapshot): RibbonState | null {
  const { items } = snapshot;
  if (items.length === 0) {
    if (snapshot.finished === 0) return null;
    return {
      progress: 1,
      sentence: counted("ribbon.done.one", "ribbon.done.other", snapshot.finished),
      status: "done",
    };
  }

  // One pass over the queue (it can hold 10,000 rows and this runs on every change of it).
  // The batch: every file that is or was on its way. A restored row has no file yet; an empty
  // folder of a folder upload is a row of the panel but not a file of the count.
  let total = 0;
  let bytes = 0;
  let sent = 0;
  let arrived = 0;
  let sending = 0;
  let allHashing = true;
  let speed = 0;
  let folders = 0;
  let conflict: UploadItem | null = null;
  const paused = { files: 0, folders: 0 };
  // The first paused row whose reason is not the user's, per kind: its reason is the queue's.
  const reasons: { files?: PauseReason | null; folders?: PauseReason | null } = {};
  let scanning = 0;
  let waiting = 0;
  let unconfirmed = 0;
  let failed = 0;
  let stillChecking = 0;
  let refused = 0;
  let blocked = 0;
  let unscanned = 0;
  for (const item of items) {
    const restored = isRestored(item);
    if (item.kind === "file" && !restored && item.state !== "cancelled") {
      total += 1;
      bytes += item.size;
      sent += Math.min(item.size, item.sentBytes);
      if (
        item.state === "scanning" ||
        item.state === "done" ||
        item.state === "error" ||
        item.state === "refused"
      ) {
        arrived += 1;
      }
      if (isSending(item)) {
        sending += 1;
        speed += item.speed;
        if (item.state !== "hashing") allHashing = false;
      }
      if (item.state === "paused") {
        paused.files += 1;
        if (!("files" in reasons) && item.pauseReason !== "user") reasons.files = item.pauseReason;
      }
    }
    if (item.kind === "folder") {
      if (isSending(item)) folders += 1;
      if (item.state === "paused") {
        paused.folders += 1;
        if (!("folders" in reasons) && item.pauseReason !== "user") reasons.folders = item.pauseReason;
      }
    }
    if (conflict === null && item.state === "conflict") conflict = item;
    if (item.state === "scanning") scanning += 1;
    if (restored && item.state === "paused") waiting += 1;
    if (item.state === "error") {
      if (item.unconfirmed) unconfirmed += 1;
      else failed += 1;
    }
    if (item.state === "done" && item.scanStatus === "pending") stillChecking += 1;
    if (item.state === "refused") refused += 1;
    if (isBlocked(item)) blocked += 1;
    if (isUnscanned(item)) unscanned += 1;
  }
  // Counting each file as one extra unit keeps empty files, and a batch of them, moving the line.
  const progress = total === 0 ? 0 : (sent + arrived) / (bytes + total);
  const n = Math.min(total, arrived + 1);
  const left = formatBytes(Math.max(0, bytes - sent));

  if (sending > 0) {
    if (allHashing) {
      return { progress, sentence: t("ribbon.verifying", { n, total }), status: "active" };
    }
    const sentence =
      speed > 0
        ? t("ribbon.uploadingEta", { n, total, left, eta: formatEta((bytes - sent) / speed) })
        : t("ribbon.uploading", { n, total, left });
    return { progress, sentence, status: "active" };
  }

  if (folders > 0) {
    return {
      progress,
      sentence: counted("ribbon.folders.one", "ribbon.folders.other", folders),
      status: "active",
    };
  }

  if (conflict) {
    return { progress, sentence: t("ribbon.conflict", { name: conflict.name }), status: "paused" };
  }

  if (paused.files > 0) {
    const reason = reasons.files;
    const sentence =
      reason && reason !== "user" ? t(PAUSE_SENTENCE[reason]) : t("ribbon.paused", { n, total, left });
    return { progress, sentence, status: "paused" };
  }
  // A drop of empty folders only, paused: still the ribbon's (and with it the panel's Resume all).
  if (paused.folders > 0) {
    const reason = reasons.folders;
    const sentence =
      reason && reason !== "user"
        ? t(PAUSE_SENTENCE[reason])
        : counted("ribbon.folders.paused.one", "ribbon.folders.paused.other", paused.folders);
    return { progress, sentence, status: "paused" };
  }

  if (scanning > 0) {
    return {
      progress: 1,
      sentence: counted("ribbon.scanning.one", "ribbon.scanning.other", scanning),
      status: "active",
    };
  }

  if (waiting > 0) {
    return {
      progress: 0,
      sentence: counted("ribbon.resume.one", "ribbon.resume.other", waiting),
      status: "paused",
    };
  }

  if (failed > 0) {
    return {
      progress: 1,
      sentence: counted("ribbon.failed.one", "ribbon.failed.other", failed),
      status: "error",
    };
  }
  if (refused > 0) {
    return {
      progress: 1,
      sentence: counted("ribbon.refused.one", "ribbon.refused.other", refused),
      status: "error",
    };
  }
  if (blocked > 0) {
    return {
      progress: 1,
      sentence: counted("ribbon.blocked.one", "ribbon.blocked.other", blocked),
      status: "error",
    };
  }
  if (unconfirmed > 0) {
    return {
      progress: 1,
      sentence: counted("ribbon.unconfirmed.one", "ribbon.unconfirmed.other", unconfirmed),
      status: "paused",
    };
  }
  if (stillChecking > 0) {
    return {
      progress: 1,
      sentence: counted("ribbon.stillChecking.one", "ribbon.stillChecking.other", stillChecking),
      status: "paused",
    };
  }
  if (unscanned > 0) {
    return {
      progress: 1,
      sentence: counted("ribbon.unscanned.one", "ribbon.unscanned.other", unscanned),
      status: "paused",
    };
  }
  return null;
}

const PAUSED: Record<PauseReason, Parameters<typeof t>[0]> = {
  user: "row.paused",
  offline: "row.offline",
  auth: "row.auth",
  ceiling: "row.ceiling",
  disabled: "row.disabled",
  limited: "row.limited",
  open: "row.open",
};

/** The row's state in words. Null when the scan status says it instead. */
export function describeItem(item: UploadItem): string | null {
  if (item.kind === "folder") {
    if (item.state === "uploading") return t("row.folderCreating");
    if (item.state === "done") return t("row.folderDone");
  }
  switch (item.state) {
    case "queued":
      return item.waitingFolder ? t("row.waitingFolder") : t("row.waiting");
    case "uploading": {
      const params = { sent: formatBytes(item.sentBytes), size: formatBytes(item.size) };
      if (item.speed <= 0) return t("row.uploading", params);
      const speed = formatBytes(item.speed);
      return item.eta === null
        ? t("row.uploadingSpeed", { ...params, speed })
        : t("row.uploadingEta", { ...params, speed, eta: formatEta(item.eta) });
    }
    case "hashing":
      return t("row.verifying");
    case "completing":
      return t("row.finishing");
    case "scanning":
      return t("row.scanning");
    case "done":
      if (item.scanStatus === "pending") return t("row.stillChecking");
      return item.scanStatus === null || item.scanStatus === "clean" ? t("row.done") : null;
    case "cancelled":
      return t("row.cancelled");
    case "paused":
      if (isRestored(item)) return t("row.selectAgain", { name: item.name });
      return t(PAUSED[item.pauseReason ?? "user"]);
    case "conflict":
      return t("row.conflict");
    case "refused":
      return t("row.refused");
    case "error":
      return item.message ?? t("row.failed");
  }
}

/**
 * Which rows the panel draws when the queue is longer than `cap`. Rows in flight, rows that failed
 * or were refused, conflicts and flagged files are always drawn — they are the ones a person can
 * act on (there are at most a few in flight; failures are the person's to see). Then, up to the
 * cap: paused rows, rows waiting on the scanner (no action, so a thousand of them are counted, not
 * drawn), waiting rows and finished rows, in that order of claim. The queue's own order is kept.
 */
/** Rows that wait on the scanner and have nothing to act on: counted in their own line when not drawn. */
export const isStillChecking = (item: UploadItem): boolean =>
  item.state === "scanning" || (item.state === "done" && item.scanStatus === "pending");

export function rowsToDraw(items: readonly UploadItem[], cap: number): UploadItem[] {
  if (items.length <= cap) return [...items];
  const rank = (item: UploadItem): number => {
    switch (item.state) {
      case "uploading":
      case "hashing":
      case "completing":
      case "error":
      case "refused":
      case "conflict":
        return 0;
      case "paused":
        return 1;
      case "scanning":
        return 2;
      case "queued":
        return 3;
      case "done":
        if (item.scanStatus === null || item.scanStatus === "clean") return 4;
        // Given up on by the scan's bound: still being checked, nothing to do — counted, not drawn.
        return item.scanStatus === "pending" ? 2 : 0;
      case "cancelled":
        return 4;
    }
  };
  const chosen = new Set<string>();
  for (const item of items) if (rank(item) === 0) chosen.add(item.id);
  for (let wanted = 1; wanted <= 4 && chosen.size < cap; wanted += 1) {
    for (const item of items) {
      if (chosen.size >= cap) break;
      if (rank(item) === wanted) chosen.add(item.id);
    }
  }
  return items.filter((item) => chosen.has(item.id));
}

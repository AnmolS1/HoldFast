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

  // The batch: every file that is or was on its way. A restored row has no file yet.
  const batch = items.filter((item) => !isRestored(item) && item.state !== "cancelled");
  const total = batch.length;
  const bytes = batch.reduce((sum, item) => sum + item.size, 0);
  const sent = batch.reduce((sum, item) => sum + Math.min(item.size, item.sentBytes), 0);
  const arrived = batch.filter(
    (item) =>
      item.state === "scanning" ||
      item.state === "done" ||
      item.state === "error" ||
      item.state === "refused",
  ).length;
  // Counting each file as one extra unit keeps empty files, and a batch of them, moving the line.
  const progress = total === 0 ? 0 : (sent + arrived) / (bytes + total);
  const n = Math.min(total, arrived + 1);
  const left = formatBytes(Math.max(0, bytes - sent));

  const sending = batch.filter(isSending);
  if (sending.length > 0) {
    if (sending.every((item) => item.state === "hashing")) {
      return { progress, sentence: t("ribbon.verifying", { n, total }), status: "active" };
    }
    const speed = sending.reduce((sum, item) => sum + item.speed, 0);
    const sentence =
      speed > 0
        ? t("ribbon.uploadingEta", { n, total, left, eta: formatEta((bytes - sent) / speed) })
        : t("ribbon.uploading", { n, total, left });
    return { progress, sentence, status: "active" };
  }

  const conflict = items.find((item) => item.state === "conflict");
  if (conflict) {
    return { progress, sentence: t("ribbon.conflict", { name: conflict.name }), status: "paused" };
  }

  const paused = batch.filter((item) => item.state === "paused");
  if (paused.length > 0) {
    const reason = paused.find((item) => item.pauseReason !== "user")?.pauseReason;
    const sentence =
      reason && reason !== "user" ? t(PAUSE_SENTENCE[reason]) : t("ribbon.paused", { n, total, left });
    return { progress, sentence, status: "paused" };
  }

  const scanning = items.filter((item) => item.state === "scanning").length;
  if (scanning > 0) {
    return {
      progress: 1,
      sentence: counted("ribbon.scanning.one", "ribbon.scanning.other", scanning),
      status: "active",
    };
  }

  const waiting = items.filter((item) => isRestored(item) && item.state === "paused").length;
  if (waiting > 0) {
    return {
      progress: 0,
      sentence: counted("ribbon.resume.one", "ribbon.resume.other", waiting),
      status: "paused",
    };
  }

  const unconfirmed = items.filter((item) => item.state === "error" && item.unconfirmed).length;
  const failed = items.filter((item) => item.state === "error" && !item.unconfirmed).length;
  const stillChecking = items.filter((item) => item.state === "done" && item.scanStatus === "pending").length;
  const refused = items.filter((item) => item.state === "refused").length;
  const blocked = items.filter(isBlocked).length;
  const unscanned = items.filter(isUnscanned).length;
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
 * Which rows the panel draws when the queue is longer than `cap`. Rows in flight and rows that
 * failed are always drawn — they are the ones a person can act on; then, up to the cap, paused
 * rows, waiting rows and finished rows, in that order of claim. The queue's own order is kept.
 */
export function rowsToDraw(items: readonly UploadItem[], cap: number): UploadItem[] {
  if (items.length <= cap) return [...items];
  const rank = (item: UploadItem): number => {
    switch (item.state) {
      case "uploading":
      case "hashing":
      case "completing":
      case "scanning":
      case "error":
      case "refused":
      case "conflict":
        return 0;
      case "paused":
        return 1;
      case "queued":
        return 2;
      case "done":
        return item.scanStatus === null || item.scanStatus === "clean" ? 3 : 0;
      case "cancelled":
        return 3;
    }
  };
  const chosen = new Set<string>();
  for (const item of items) if (rank(item) === 0) chosen.add(item.id);
  for (let wanted = 1; wanted <= 3 && chosen.size < cap; wanted += 1) {
    for (const item of items) {
      if (chosen.size >= cap) break;
      if (rank(item) === wanted) chosen.add(item.id);
    }
  }
  return items.filter((item) => chosen.has(item.id));
}

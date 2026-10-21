// How a link is put into words for its owner: its settings as one sentence ("Anyone with the
// link can view · no password · expires in 7 days · unlimited downloads"), its state, and why it
// is paused — one line per reason the API gives (`pausedReasons` is already the non-leaking set).
import type { LinkDto, LinkPauseReason, LinkState } from "../../../shared/schemas/link";
import { t } from "./strings";

/** The four settings a sentence segment edits. */
export type LinkSetting = "preview" | "password" | "expiry" | "limit";

export interface SentenceSegment {
  setting: LinkSetting;
  text: string;
}

const DAY_MS = 86_400_000;

/** "in 7 days", "in 3 hours", "tomorrow": how far an expiry lies ahead, in the locale's words. */
export function expiresWords(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (ms < DAY_MS) return format.format(Math.max(1, Math.round(ms / 3_600_000)), "hour");
  return format.format(Math.round(ms / DAY_MS), "day");
}

/** The sentence's segments after "Anyone with the link", in their fixed order. */
export function linkSentence(
  link: Pick<LinkDto, "allowPreview" | "hasPassword" | "expiresAt" | "maxDownloads">,
  now: number,
): SentenceSegment[] {
  const expired = link.expiresAt !== null && Date.parse(link.expiresAt) <= now;
  return [
    {
      setting: "preview",
      text: t(link.allowPreview ? "link.sentence.canView" : "link.sentence.canDownload"),
    },
    {
      setting: "password",
      text: t(link.hasPassword ? "link.sentence.password" : "link.sentence.noPassword"),
    },
    {
      setting: "expiry",
      text:
        link.expiresAt === null
          ? t("link.sentence.noExpiry")
          : expired
            ? t("link.sentence.expired")
            : t("link.sentence.expiresIn", { when: expiresWords(link.expiresAt, now) }),
    },
    {
      setting: "limit",
      text:
        link.maxDownloads === null
          ? t("link.sentence.unlimited")
          : link.maxDownloads === 1
            ? t("link.sentence.limit.one")
            : t("link.sentence.limit", { count: link.maxDownloads }),
    },
  ];
}

const STATE_KEY = {
  active: "link.state.active",
  paused: "link.state.paused",
  expired: "link.state.expired",
  revoked: "link.state.revoked",
  limit_reached: "link.state.limit_reached",
  locked: "link.state.locked",
} as const satisfies Record<LinkState, string>;

export const stateWords = (state: LinkState): string => t(STATE_KEY[state]);

const PAUSE_KEY = {
  traffic: "link.paused.traffic",
  review: "link.paused.review",
  account: "link.paused.account",
  owner: "link.paused.owner",
} as const satisfies Record<LinkPauseReason, string>;

/** One line per reason, in the API's order. */
export const pausedLines = (reasons: readonly LinkPauseReason[]): string[] =>
  reasons.map((reason) => t(PAUSE_KEY[reason]));

/** "3 downloads", "3 of 10 downloads". */
export function countWords(link: Pick<LinkDto, "downloadCount" | "maxDownloads">): string {
  if (link.maxDownloads !== null)
    return t("link.counts.of", { count: link.downloadCount, max: link.maxDownloads });
  return link.downloadCount === 1 ? t("link.counts.one") : t("link.counts", { count: link.downloadCount });
}

/**
 * The owner may pause a link that is live, and resume one only when the API says so
 * (`canUnpause`): a link paused for traffic, a review or the account is not theirs to resume.
 */
export function pauseAction(link: Pick<LinkDto, "state" | "canUnpause">): "pause" | "resume" | null {
  if (link.state === "active") return "pause";
  if (link.state === "paused" && link.canUnpause) return "resume";
  return null;
}

/** Copy text to the clipboard; false when the browser refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export type ExpiryChoice = "never" | "1d" | "7d" | "30d" | "custom";

/** The expiry a choice stands for, from `now`; `custom` reads the date field (end of that day, local). */
export function expiryOf(choice: ExpiryChoice, custom: string, now: number): string | null | undefined {
  if (choice === "never") return null;
  if (choice === "custom") {
    if (!custom) return undefined;
    const end = new Date(`${custom}T23:59:59`);
    return Number.isNaN(end.getTime()) ? undefined : end.toISOString();
  }
  const days = { "1d": 1, "7d": 7, "30d": 30 }[choice];
  return new Date(now + days * DAY_MS).toISOString();
}

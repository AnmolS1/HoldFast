// The text of the `_not_included.txt` that "Download everything" writes into its zip: every file
// the manifest left out and why, and — when the manifest was cut at ZIP_MAX_ENTRIES — that the zip
// holds the first files only. Nothing is silently missing.
import { ZIP_MAX_ENTRIES } from "../../../shared/constants";
import type { ZipResult } from "../explorer";
import { t, type AccountMessage } from "./strings";

const REASON: Record<ZipResult["leftOut"][number]["reason"], AccountMessage> = {
  scan_pending: "data.zip.notIncluded.pending",
  scan_blocked: "data.zip.notIncluded.blocked",
  unscanned: "data.zip.notIncluded.unscanned",
};

export function notIncludedText({
  leftOut,
  truncated,
}: Pick<ZipResult, "leftOut" | "truncated">): string | null {
  if (leftOut.length === 0 && !truncated) return null;
  const lines = [t("data.zip.notIncluded.title"), ""];
  for (const item of leftOut) lines.push(`${item.path} — ${t(REASON[item.reason])}`);
  if (truncated) {
    if (leftOut.length > 0) lines.push("");
    lines.push(t("data.zip.notIncluded.truncated", { count: ZIP_MAX_ENTRIES.toLocaleString("en") }));
  }
  return `${lines.join("\n")}\n`;
}

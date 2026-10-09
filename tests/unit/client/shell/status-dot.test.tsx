import { describe, expect, it } from "vitest";
import { STATUS_PRESENTATION, StatusDot, statusSentence } from "../../../../src/client/components/StatusDot";
import type { ScanStatus } from "../../../../src/client/components/types";
import { renderShell, setupShell } from "./helpers";

setupShell();

// status → [token, sentence]. `null` token = nothing drawn.
const TABLE: Record<ScanStatus, [string | null, string | null]> = {
  clean: [null, null],
  pending: ["accentText", "Scanning"],
  infected: ["danger", "Blocked — flagged by the malware scan"],
  under_review: ["textSecondary", "Under review"],
  suspected_csam: ["textSecondary", "Under review"],
  skipped: ["attention", "Couldn't scan"],
  error: ["attention", "Couldn't scan — try again"],
};

describe("StatusDot", () => {
  it("the table covers every status", () => {
    expect(Object.keys(TABLE).sort()).toEqual(Object.keys(STATUS_PRESENTATION).sort());
  });

  it.each(Object.entries(TABLE) as Array<[ScanStatus, [string | null, string | null]]>)("%s → token and sentence", (status, [token, sentence]) => {
    expect(STATUS_PRESENTATION[status].token).toBe(token);
    expect(statusSentence(status)).toBe(sentence);
    const { container } = renderShell(<StatusDot status={status} variant="sentence" />);
    const node = container.querySelector("[data-status]");
    if (sentence === null) {
      expect(node).toBeNull();
    } else {
      expect(node?.getAttribute("data-token")).toBe(token);
      expect(node?.textContent).toBe(sentence);
    }
  });

  it("clean renders nothing in either variant", () => {
    expect(renderShell(<StatusDot status="clean" />).container.querySelector("[data-status]")).toBeNull();
    expect(renderShell(<StatusDot status="clean" variant="sentence" />).container.querySelector("[data-status]")).toBeNull();
  });

  it("pending renders no glyph (the row's underline shows it) but a sentence", () => {
    expect(renderShell(<StatusDot status="pending" />).container.querySelector("[data-status]")).toBeNull();
    expect(renderShell(<StatusDot status="pending" variant="sentence" />).container.textContent).toBe("Scanning");
  });

  it("suspected_csam is presented exactly as under review — never a category", () => {
    const a = renderShell(<StatusDot status="suspected_csam" variant="sentence" />).container.querySelector("[data-status]");
    const b = renderShell(<StatusDot status="under_review" variant="sentence" />).container.querySelector("[data-status]");
    expect(a?.textContent).toBe("Under review");
    expect(a?.textContent).toBe(b?.textContent);
    expect(a?.getAttribute("data-token")).toBe(b?.getAttribute("data-token"));
    expect(a?.outerHTML.replace("suspected_csam", "under_review")).toBe(b?.outerHTML);
    expect(document.body.textContent).not.toMatch(/csam|abuse|child/i);
  });

  it("the glyph is never colour alone: it carries the sentence as its accessible name", () => {
    for (const status of ["infected", "under_review", "skipped", "error"] as const) {
      const { container } = renderShell(<StatusDot status={status} />);
      const glyph = container.querySelector('[role="img"]');
      expect(glyph?.getAttribute("aria-label")).toBe(TABLE[status][1]);
    }
  });

  it("a size skip says so", () => {
    expect(statusSentence("skipped", "size")).toBe("Couldn't scan — too large to scan");
    expect(statusSentence("skipped", "other")).toBe("Couldn't scan");
  });

  it("flagged is the danger colour, never the activity colour", () => {
    expect(STATUS_PRESENTATION.infected.token).toBe("danger");
    for (const status of ["infected", "under_review", "suspected_csam", "skipped", "error", "clean"] as const) {
      expect(STATUS_PRESENTATION[status].token).not.toBe("accentText");
    }
  });
});

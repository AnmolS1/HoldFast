// Storage: the bar's thresholds, the breakdown's arithmetic, the page, and that nothing of an
// account outlives its sign-out.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usageBreakdown } from "../../../../src/client/features/usage/queries";
import { viewKeys, VIEWS_KEY } from "../../../../src/client/features/starred/view-queries";
import { purgeUserState, queryClient } from "../../../../src/client/lib/query";
import { lightTokens } from "../../../../src/client/theme/tokens";
import { resolveVar, setupShell } from "../shell/helpers";
import { remaining, TRASH, trashPage, usage, USAGE, USAGE_AFTER_EMPTY } from "./fixtures";
import { json, openView, requests, rowNames } from "./helpers";

setupShell();

const main = () => within(document.querySelector<HTMLElement>("[data-main]")!);
const part = (name: string) => document.querySelector(`[data-usage-part="${name}"]`)!.textContent;

describe("usageBreakdown", () => {
  it("lists files, trash, previous versions and uploads in progress, in that order", () => {
    expect(usageBreakdown(USAGE).parts).toEqual([
      { part: "files", bytes: 900_000_000 },
      { part: "trash", bytes: 300_000_000 },
      { part: "versions", bytes: 150_000_000 },
      { part: "reserved", bytes: 50_000_000 },
    ]);
  });

  it("free = quota − used, never below zero; over = used − quota", () => {
    expect(usageBreakdown(USAGE)).toMatchObject({ freeBytes: 3_600_000_000, overBytes: 0, ratio: 0.28 });
    expect(usageBreakdown(usage({ usedBytes: 5_200_000_000 }))).toMatchObject({
      freeBytes: 0,
      overBytes: 200_000_000,
      ratio: 1,
      level: "full",
    });
    expect(usageBreakdown(usage({ usedBytes: 0, quotaBytes: 0 }))).toMatchObject({
      ratio: 0,
      level: "neutral",
    });
  });

  it("neutral at 89 %, attention from 90 %", () => {
    const at = (percent: number) => usageBreakdown(usage({ usedBytes: percent, quotaBytes: 100 })).level;
    expect(at(89)).toBe("neutral");
    expect(at(90)).toBe("attention");
    expect(at(99)).toBe("attention");
    expect(at(100)).toBe("full");
  });
});

describe("/storage", () => {
  it("one bar with the numbers in user units, the breakdown, and the sentence about what counts", async () => {
    await openView("/storage", { "GET /api/trash": TRASH });
    await waitFor(() => expect(document.querySelector("[data-usage-part]")).not.toBeNull());
    expect(main().getByText("1.4 GB of 5 GB")).toBeTruthy();
    expect(main().getAllByRole("img", { name: "1.4 GB of 5 GB used" })).toHaveLength(1);
    expect(document.querySelector("[data-usage-free]")!.textContent).toBe("3.6 GB free");
    expect([part("files"), part("trash"), part("versions"), part("reserved")]).toEqual([
      "Files900 MB",
      "Trash300 MB",
      "Previous versions150 MB",
      "Uploads in progress50 MB",
    ]);
    expect(
      main().getByText(
        "Items in the trash and earlier versions of replaced files count toward your storage until they're deleted for good.",
      ),
    ).toBeTruthy();
    expect(main().queryByText("Almost full")).toBeNull();
    // Wide page: the details panel is hidden here.
    expect(document.querySelector("[data-details-panel]")).toBeNull();
  });

  it("89 % is neutral: no warning", async () => {
    await openView("/storage", { "GET /api/account/usage": usage({ usedBytes: 89, quotaBytes: 100 }) });
    await waitFor(() => expect(document.querySelector('[data-usage-level="neutral"]')).not.toBeNull());
    expect(main().queryByText("Almost full")).toBeNull();
  });

  it("90 %: 'Almost full' as a sentence in the attention colour — the bar itself stays graphite", async () => {
    await openView("/storage", { "GET /api/account/usage": usage({ usedBytes: 90, quotaBytes: 100 }) });
    await waitFor(() => expect(document.querySelector('[data-usage-level="attention"]')).not.toBeNull());
    const warning = main().getByText("Almost full");
    expect(resolveVar(getComputedStyle(warning).color)).toBe(lightTokens.attention);
    const fill = document.querySelector('[data-view="usage"] [data-storage-fill]')!;
    expect(resolveVar(getComputedStyle(fill).backgroundColor)).toBe(lightTokens.textSecondary);
  });

  it("the 'Empty trash' shortcut empties the trash and the numbers change", async () => {
    let emptied = false;
    const { calls } = await openView("/storage", {
      "GET /api/trash": () => json(emptied ? trashPage([]) : TRASH),
      "GET /api/account/usage": () => json(emptied ? USAGE_AFTER_EMPTY : USAGE),
      "DELETE /api/trash": () => {
        if (emptied) return new Response(null, { status: 204 });
        emptied = true;
        return json(remaining(1), 202);
      },
    });
    await waitFor(() => expect(part("trash")).toBe("Trash300 MB"));
    await waitFor(() =>
      expect((main().getByRole("button", { name: "Empty trash" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(main().getByRole("button", { name: "Empty trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Empty trash" }));
    await waitFor(() => expect(part("trash")).toBe("Trash0 B"));
    expect(main().getByText("1.1 GB of 5 GB")).toBeTruthy();
    expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(main().getByRole("link", { name: "Open the trash" }).getAttribute("href")).toBe("/trash");
  });

  it("when the trash cannot be read, emptying it asks for the word", async () => {
    await openView("/storage");
    await waitFor(() => expect(document.querySelector("[data-usage-part]")).not.toBeNull());
    await waitFor(() => expect(queryClient.getQueryState(viewKeys.trash)?.status).toBe("error"));
    fireEvent.click(main().getByRole("button", { name: "Empty trash" }));
    const dialog = await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(within(dialog).getByText(/Everything in the trash is deleted\./)).toBeTruthy();
    expect(within(dialog).getByLabelText("Type DELETE to confirm")).toBeTruthy();
  });
});

describe("account state", () => {
  it("sign-out or an account switch leaves none of the views' data behind", async () => {
    await openView("/trash", { "GET /api/trash": TRASH });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    const mine = () => queryClient.getQueryCache().findAll({ queryKey: [VIEWS_KEY] });
    expect(
      mine()
        .map((query) => query.queryKey[1])
        .sort(),
    ).toEqual(["trash", "usage"]);
    expect(queryClient.getQueryData(viewKeys.usage)).toEqual(USAGE);
    await purgeUserState();
    expect(queryClient.getQueryData(viewKeys.usage)).toBeUndefined();
    expect(queryClient.getQueryData(viewKeys.trash)).toBeUndefined();
    expect(mine().every((query) => query.state.data === undefined)).toBe(true);
  });
});

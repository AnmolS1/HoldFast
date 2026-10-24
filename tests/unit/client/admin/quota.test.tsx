// func-5 (R1): the quota field. An empty or unreadable value is refused on screen and nothing is
// sent (it used to set a 0-byte quota); a decimal comma is read as a decimal point.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { json, setupShell, type MockCall } from "../shell/helpers";
import { adminFetch, DEFAULT_ADMIN, openConsole, OTHER_ID } from "./helpers";

setupShell();

const quotaCalls = (calls: MockCall[]) =>
  calls.filter((call) => call.method === "PATCH" && call.path === `/api/admin/users/${OTHER_ID}/quota`);

function api() {
  return adminFetch(
    (call) =>
      call.method === "PATCH" && call.path.endsWith("/quota")
        ? json(DEFAULT_ADMIN[`/api/admin/users/${OTHER_ID}`])
        : undefined,
    DEFAULT_ADMIN,
  );
}

async function setQuotaTo(value: string) {
  const field = await screen.findByLabelText(/Quota \(GB\)/);
  fireEvent.change(field, { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Set quota" }));
}

describe("the quota field", () => {
  it("empty, blank or not a number: refused with a message, nothing sent", async () => {
    const calls = api();
    openConsole(`/admin/users/${OTHER_ID}`);
    for (const value of ["", "   ", "lots", "-1"]) {
      await setQuotaTo(value);
      await screen.findByText("Enter the quota in GB, for example 5 or 2.5.");
    }
    expect(quotaCalls(calls)).toEqual([]);
  });

  it("a decimal comma is a decimal point: 1,5 → 1.5 GB", async () => {
    const calls = api();
    openConsole(`/admin/users/${OTHER_ID}`);
    await setQuotaTo("1,5");
    await waitFor(() => expect(quotaCalls(calls)).toHaveLength(1));
    expect(quotaCalls(calls)[0]!.body).toEqual({ quotaBytes: 1_500_000_000 });
  });
});

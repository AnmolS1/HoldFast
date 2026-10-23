// The quarantine item's takedown, restore and legal hold (R1 ruling Q9), and "Find an item": a
// files link is read in the browser — only the node id reaches a URL or a request.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { nodeIdOf } from "../../../../src/client/features/admin/words";
import { json, setupShell, type MockCall } from "../shell/helpers";
import { adminFetch, adminNode, DEFAULT_ADMIN, NODE, openConsole, quarantineDetail } from "./helpers";

setupShell();

const TOKEN = "MadeUpTokenNotARealOne0123456789abcdef";

function api(detail: Record<string, unknown>) {
  const fixtures = { ...DEFAULT_ADMIN, [`/api/admin/quarantine/${NODE}`]: detail };
  return adminFetch((call) => {
    if (call.method !== "POST" || !call.path.startsWith(`/api/admin/quarantine/${NODE}`)) return undefined;
    if (call.path.endsWith("/legal-hold")) return json(detail);
    return json({ node: (detail.item as { node: unknown }).node, reportStrikeIds: [] });
  }, fixtures);
}

const posted = (calls: MockCall[]) =>
  calls
    .filter((call) => call.method === "POST" && call.path.startsWith("/api/admin/quarantine/"))
    .map((call) => [call.path, call.body]);

async function drive(action: string) {
  fireEvent.click(await screen.findByRole("button", { name: action }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(/Reason/), {
    target: { value: "Made-up reason for the test." },
  });
  fireEvent.click(within(dialog).getAllByRole("button").at(-1)!);
  await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).toBeNull());
}

const folder = (patch: Record<string, unknown> = {}) =>
  quarantineDetail({
    item: {
      node: adminNode({ kind: "folder", scanStatus: "clean", ...patch }),
      uploader: null,
      signatures: [],
      scannedAt: null,
    },
  });

describe("a quarantine item's takedown, restore and legal hold", () => {
  it("a folder: Take down, Take down as suspected CSAM and Set legal hold post what they say", async () => {
    const calls = api(folder());
    openConsole(`/admin/quarantine/${NODE}`);
    await drive("Take down");
    await drive("Take down as suspected CSAM");
    await drive("Set legal hold");
    expect(posted(calls)).toEqual([
      [`/api/admin/quarantine/${NODE}`, { action: "takedown", note: "Made-up reason for the test." }],
      [
        `/api/admin/quarantine/${NODE}`,
        { action: "takedown", note: "Made-up reason for the test.", csam: true },
      ],
      [`/api/admin/quarantine/${NODE}/legal-hold`, { held: true, note: "Made-up reason for the test." }],
    ]);
  });

  it("a file is not offered a CSAM takedown; a taken-down item offers Restore; a held one Clear legal hold", async () => {
    const calls = api(
      quarantineDetail({
        item: {
          node: adminNode({ takedown: { reason: "abuse", at: new Date().toISOString() } }),
          uploader: null,
          signatures: [],
          scannedAt: null,
        },
        holds: ["node_legal_hold"],
      }),
    );
    openConsole(`/admin/quarantine/${NODE}`);
    await screen.findByRole("button", { name: "Restore takedown" });
    expect(screen.queryByRole("button", { name: "Take down as suspected CSAM" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Take down" })).toBeNull();
    await drive("Restore takedown");
    await drive("Clear legal hold");
    expect(posted(calls)).toEqual([
      [`/api/admin/quarantine/${NODE}`, { action: "restore", note: "Made-up reason for the test." }],
      [`/api/admin/quarantine/${NODE}/legal-hold`, { held: false, note: "Made-up reason for the test." }],
    ]);
  });
});

describe("find an item", () => {
  it("reads the node id from an id, an object key or a files link; anything else is refused", () => {
    expect(nodeIdOf(NODE.toUpperCase())).toBe(NODE);
    expect(nodeIdOf(`u/${"A".repeat(32)}/${NODE}/0199d3c2-7a10-7000-8000-0000000000ff`)).toBe(NODE);
    expect(nodeIdOf(`https://files.example.test/d/${NODE}/${TOKEN}`)).toBe(NODE);
    expect(nodeIdOf(`/t/${NODE}/256/${TOKEN}`)).toBe(NODE);
    expect(nodeIdOf(`https://holdfast.example.test/s/${TOKEN}`)).toBeNull();
    expect(nodeIdOf("not a reference")).toBeNull();
  });

  it("opens the item by its id — the token never reaches a URL or a request", async () => {
    const calls = api(folder());
    openConsole("/admin/quarantine");
    fireEvent.change(await screen.findByLabelText(/Item id, object key or files link/), {
      target: { value: `https://files.example.test/d/${NODE}/${TOKEN}` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("button", { name: "Take down" });
    expect(calls.some((call) => call.path.includes(TOKEN))).toBe(false);
    expect(calls.some((call) => call.path === `/api/admin/quarantine/${NODE}`)).toBe(true);
  });
});

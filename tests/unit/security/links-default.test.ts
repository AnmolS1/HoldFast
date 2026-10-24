// R1 secsrv-n1: public links FAIL CLOSED. With no `linksEnabled` row in the settings table, links
// are off — prod relies on links being off, and a missing or unreadable row must not turn them on.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { resolveSettings } from "../../../src/worker/services/request-context";
import { errorOf, makeFile, makeFolder, member } from "../sharing/helpers";
import { linkTo, visit } from "../sharing/public-helpers";

describe("linksEnabled with no settings row", () => {
  it("resolves to false (and an explicit true stays true)", () => {
    expect(resolveSettings(env, {}).linksEnabled).toBe(false);
    expect(resolveSettings(env, { linksEnabled: true }).linksEnabled).toBe(true);
  });

  it("a real link is 423 unavailable when the settings table has no linksEnabled row", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    await makeFile(owner.id, folder.id, { scanStatus: "clean", name: "doc.txt", size: 10 });
    const link = await linkTo(owner, folder.id);
    const answer = await visit(link.token, "", { settings: {} });
    expect([answer.status, errorOf(answer).error, errorOf(answer).details?.reason]).toEqual([
      423,
      "link_paused",
      "unavailable",
    ]);
  });
});

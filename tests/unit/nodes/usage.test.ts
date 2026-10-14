// GET /account/usage: the caller's own six numbers. What is hidden from the owner still counts —
// the meter must not move when a file is hidden.
import { describe, expect, it } from "vitest";
import { UsageDto } from "../../../src/shared/schemas/account";
import { api, makeFile, makeFolder, makeUpload, person, setStatus, takeDown } from "./helpers";

describe("GET /account/usage", () => {
  it("six fields, the caller's own", async () => {
    const owner = await person({ usedBytes: 1_650, quotaBytes: 50_000 });
    const other = await person({ usedBytes: 7, quotaBytes: 99 });
    const folder = await makeFolder(owner.id);
    await makeFile(owner.id, folder.id, { size: 1_000, scanStatus: "clean" });
    await makeFile(owner.id, null, { size: 200, scanStatus: "pending" });
    const bin = await makeFolder(owner.id, null, { deletedAt: new Date(), trashedRoot: true });
    await makeFile(owner.id, bin.id, { size: 50, scanStatus: "clean" });
    await makeUpload(owner.id, owner.id, { size: 400 });
    // An avatar never counts.
    await makeFile(owner.id, null, { size: 9_999, scanStatus: "clean", system: "avatar" });

    const answer = await api(owner.as, "GET", "/account/usage");
    expect(answer.status).toBe(200);
    expect(UsageDto.parse(answer.body)).toEqual({
      usedBytes: 1_650,
      quotaBytes: 50_000,
      filesBytes: 1_200,
      trashBytes: 50,
      versionsBytes: 0,
      reservedBytes: 400,
    });
    expect(Object.keys(answer.body).sort()).toEqual(
      ["filesBytes", "quotaBytes", "reservedBytes", "trashBytes", "usedBytes", "versionsBytes"].sort(),
    );
    expect((await api(other.as, "GET", "/account/usage")).body).toEqual({
      usedBytes: 7,
      quotaBytes: 99,
      filesBytes: 0,
      trashBytes: 0,
      versionsBytes: 0,
      reservedBytes: 0,
    });
  });

  it("a hidden node's bytes still count: the answer is the same before and after", async () => {
    const owner = await person({ usedBytes: 3_000 });
    const folder = await makeFolder(owner.id);
    await makeFile(owner.id, folder.id, { size: 1_000, scanStatus: "clean" });
    const down = await makeFile(owner.id, null, { size: 1_500, scanStatus: "clean" });
    const locked = await makeFile(owner.id, null, { size: 500, scanStatus: "clean" });
    const before = (await api(owner.as, "GET", "/account/usage")).body;
    expect(before.filesBytes).toBe(3_000);

    await takeDown(down.id);
    await takeDown(folder.id);
    await setStatus(locked.id, "suspected_csam");
    expect((await api(owner.as, "GET", "/account/usage")).body).toEqual(before);
    // …while the files themselves are gone for their owner.
    expect((await api(owner.as, "GET", `/nodes/${down.id}`)).status).toBe(404);
    expect((await api(owner.as, "GET", "/nodes/root")).body.items).toEqual([]);
  });

  it("takes no id: there is no way to ask for another account's numbers", async () => {
    const owner = await person();
    const other = await person({ usedBytes: 4_242 });
    for (const path of [`/account/usage?userId=${other.id}`, `/account/usage/${other.id}`]) {
      const answer = await api(owner.as, "GET", path);
      expect(JSON.stringify(answer.body)).not.toContain("4242");
    }
    expect((await api(null, "GET", "/account/usage")).status).toBe(401);
  });
});

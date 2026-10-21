// The admin variant of the node mapper (ruling #24): hidden rows are answered, system rows are
// not, and the output is metadata only — checked strictly against `AdminNodeDto`.
import { describe, expect, it } from "vitest";
import { AdminNodeDto } from "../../../src/shared/schemas/admin";
import { statementsSent } from "../../../src/worker/db/client";
import { displayNames } from "../../../src/worker/db/queries/node-dto";
import { shareLinks } from "../../../src/worker/db/schema";
import { toAdminNodeDto, toAdminNodeDtos, toNodeDto } from "../../../src/worker/services/node-dto";
import { makeFile, makeFolder, makeUser, nodeById, rand, testDb } from "../services-core/helpers";

const Strict = AdminNodeDto.strict();
const SHA = "cd".repeat(32);

async function hiddenFiles() {
  const owner = await makeUser({ name: `Olive ${rand()}` });
  const editor = await makeUser({ name: `Eda ${rand()}` });
  const folder = await makeFolder(owner.id);
  const locked = await makeFile(owner.id, folder.id, {
    scanStatus: "suspected_csam",
    sha256: SHA,
    legalHold: true,
    createdBy: editor.id,
    scanDetail: { pua: ["PUA.Test"], signatures: [], engine: "stub" },
  });
  const takenDown = await makeFile(owner.id, null, {
    scanStatus: "infected",
    sha256: SHA,
    takedownAt: new Date("2099-01-01T00:00:00.000Z"),
    takedownReason: "dmca",
  });
  const pending = await makeFile(owner.id, null, { scanStatus: "pending", sha256: SHA });
  return { owner, editor, folder, locked, takenDown, pending };
}

describe("toAdminNodeDtos", () => {
  it("answers hidden rows — suspected_csam and taken down — with the three admin fields, parsed strictly", async () => {
    const t = await hiddenFiles();
    const [locked, takenDown] = await toAdminNodeDtos(testDb(), [t.locked, t.takenDown]);
    expect(Strict.parse(locked)).toEqual(locked);
    expect(Strict.parse(takenDown)).toEqual(takenDown);
    expect(locked).toMatchObject({
      scanStatus: "suspected_csam",
      takedown: null,
      legalHold: true,
      sha256: SHA,
      pua: ["PUA.Test"],
      parentId: t.folder.id,
      createdBy: { id: t.editor.id },
    });
    expect(takenDown).toMatchObject({
      scanStatus: "infected",
      takedown: { at: "2099-01-01T00:00:00.000Z", reason: "dmca" },
      legalHold: false,
    });
    // Control: the owner's mapper refuses the very same rows.
    await expect(toNodeDto(testDb(), t.locked, { viewerId: t.owner.id, role: "owner" })).rejects.toThrow(
      /hidden or system/,
    );
  });

  it("metadata only, and never an owner's affordance: role viewer, no thumbnail, no star, no last access", async () => {
    const owner = await makeUser();
    const image = await makeFile(owner.id, null, {
      name: `photo-${rand()}.png`,
      scanStatus: "clean",
      mimeSniffed: "image/png",
      starred: true,
      lastAccessedAt: new Date(),
      size: 10,
    });
    const dto = await toAdminNodeDto(testDb(), image);
    expect(Strict.parse(dto)).toEqual(dto);
    expect(dto).toMatchObject({ role: "viewer", thumb: false, starred: false, lastAccessedAt: null });
  });

  it("sha256 stays null while the scan is pending — a declared hash is not evidence", async () => {
    const t = await hiddenFiles();
    expect((await toAdminNodeDto(testDb(), t.pending)).sha256).toBeNull();
    expect((await toAdminNodeDto(testDb(), t.takenDown)).sha256).toBe(SHA);
  });

  it("the real sharing summary, and the trash stamps as the row has them", async () => {
    const owner = await makeUser();
    const file = await makeFile(owner.id, null, {
      scanStatus: "clean",
      deletedAt: new Date("2099-02-01T00:00:00.000Z"),
      purgeAfter: new Date("2099-03-01T00:00:00.000Z"),
    });
    await testDb()
      .insert(shareLinks)
      .values({
        nodeId: file.id,
        createdBy: owner.id,
        tokenHash: `made-up-hash-${rand(8)}`,
        tokenEnc: new Uint8Array([1]),
        tokenIv: new Uint8Array([1]),
      });
    const dto = await toAdminNodeDto(testDb(), (await nodeById(file.id))!);
    expect(dto.sharing.link).not.toBe("none");
    expect(dto).toMatchObject({
      deletedAt: "2099-02-01T00:00:00.000Z",
      purgeAfter: "2099-03-01T00:00:00.000Z",
    });
  });

  it("a system (avatar) row throws", async () => {
    const owner = await makeUser();
    const avatar = await makeFile(owner.id, null, { system: "avatar", scanStatus: "clean" });
    await expect(toAdminNodeDtos(testDb(), [avatar])).rejects.toThrow(/system node/);
  });

  it("batched: one names read and one sharing summary per page, whatever its length", async () => {
    const t = await hiddenFiles();
    const db = testDb();
    const cost = async (work: () => Promise<unknown>) => {
      const before = statementsSent(db);
      await work();
      return statementsSent(db) - before;
    };
    expect(await cost(() => displayNames(db, [t.owner.id]))).toBe(1);
    const one = await cost(() => toAdminNodeDtos(db, [t.locked]));
    expect(await cost(() => toAdminNodeDtos(db, [t.locked, t.takenDown, t.pending]))).toBe(one);
    expect(await cost(() => toAdminNodeDtos(db, []))).toBe(0);
  });
});

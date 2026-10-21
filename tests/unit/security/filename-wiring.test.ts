// Item 6 end to end (T26 Addendum 3, F3): the rules of services/filename.ts at the places names
// leave or are re-made — the download name (Content-Disposition), the zip entry paths of the
// explorer's and of a public link's manifest, and the name a restore into a taken place gets.
import { describe, expect, it } from "vitest";
import { contentDisposition } from "../../../src/worker/services/mime";
import { byteLength, MAX_NAME_BYTES } from "../../../src/worker/services/filename";
import { api, asCaller, makeFile, makeFolder, member, settingsWith } from "../sharing/helpers";
import { linkTo, visit } from "../sharing/public-helpers";

type Manifest = { entries: Array<{ path: string }> };
const paths = (answer: { body: unknown }) =>
  (answer.body as Manifest).entries.map((entry) => entry.path).sort();

describe("the download name", () => {
  it("a reserved Windows name is saved with `_` after its stem; any other name as it is", () => {
    expect(contentDisposition("download", "CON.txt", "text/plain")).toBe(
      `attachment; filename="CON_.txt"; filename*=UTF-8''CON_.txt`,
    );
    expect(contentDisposition("download", "nul", "application/octet-stream")).toContain(`filename="nul_"`);
    expect(contentDisposition("download", "console.txt", "text/plain")).toContain(`filename="console.txt"`);
  });
});

describe("zip entry paths", () => {
  it("the explorer's manifest: every segment of a reserved name is made safe; two roots of one 255-byte name stay within 255 bytes", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id, null, { name: "AUX" });
    await makeFile(owner.id, folder.id, { name: "CON.txt", scanStatus: "clean" });
    await makeFile(owner.id, folder.id, { name: "notes.txt", scanStatus: "clean" });
    const long = `${"中".repeat(83)}.txt`; // 249 + 4 = 253 bytes
    const a = await makeFolder(owner.id);
    const b = await makeFolder(owner.id);
    const one = await makeFile(owner.id, a.id, { name: long, scanStatus: "clean" });
    const two = await makeFile(owner.id, b.id, { name: long, scanStatus: "clean" });

    const zipped = await api(asCaller(owner), "/nodes/zip-manifest", {
      json: { nodeIds: [folder.id] },
      settings: settingsWith(),
    });
    expect(zipped.status).toBe(200);
    expect(paths(zipped)).toEqual(["AUX_/CON_.txt", "AUX_/notes.txt"]);

    const twins = await api(asCaller(owner), "/nodes/zip-manifest", {
      json: { nodeIds: [one.id, two.id] },
      settings: settingsWith(),
    });
    expect(twins.status).toBe(200);
    const labels = paths(twins);
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    for (const label of labels) expect(byteLength(label), label).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(labels.some((label) => label.endsWith(" (2).txt"))).toBe(true);
  });

  it("a public link's manifest: the same", async () => {
    const owner = await member();
    const root = await makeFolder(owner.id, null, { name: "Shared" });
    await makeFile(owner.id, root.id, { name: "COM1.log", scanStatus: "clean" });
    const link = await linkTo(owner, root.id, { maxDownloads: 100 });
    const manifest = await visit(link.token, "/zip-manifest", { method: "POST" });
    expect(manifest.status).toBe(200);
    expect(paths(manifest)).toEqual(["Shared/COM1_.log"]);
  });
});

describe("zip entry paths stay unique after the reserved-name rename (delta review D-m1)", () => {
  it("nul.txt and nul_.txt in one folder: two different entries, on a public link and in the explorer", async () => {
    const owner = await member();
    const root = await makeFolder(owner.id, null, { name: "Box" });
    for (const name of ["nul.txt", "nul_.txt", "NUL_.TXT (x)"])
      await makeFile(owner.id, root.id, { name, scanStatus: "clean" });
    const link = await linkTo(owner, root.id, { maxDownloads: 100 });
    const visitor = await visit(link.token, "/zip-manifest", { method: "POST" });
    const explorer = await api(asCaller(owner), "/nodes/zip-manifest", {
      json: { nodeIds: [root.id] },
      settings: settingsWith(),
    });
    for (const answer of [visitor, explorer]) {
      expect(answer.status).toBe(200);
      const got = paths(answer);
      expect(got).toHaveLength(3);
      expect(new Set(got.map((path) => path.toLowerCase())).size).toBe(3);
      expect(got).toContain("Box/nul_.txt");
      expect(got.some((path) => /^Box\/nul_ \(2\)\.txt$/.test(path))).toBe(true);
    }
  });
});

describe("a restore into a taken name", () => {
  it("a 255-byte name restored twice stays within 255 bytes, its extension and suffix kept", async () => {
    const owner = await member();
    const caller = asCaller(owner);
    const folder = await makeFolder(owner.id);
    const name = `${"x".repeat(MAX_NAME_BYTES - 4)}.txt`;
    const settings = settingsWith();
    const first = await makeFile(owner.id, folder.id, { name, scanStatus: "clean" });
    expect((await api(caller, `/nodes/${first.id}/trash`, { method: "POST", settings })).status).toBe(200);
    const second = await makeFile(owner.id, folder.id, { name, scanStatus: "clean" });
    expect((await api(caller, `/nodes/${second.id}/trash`, { method: "POST", settings })).status).toBe(200);
    await makeFile(owner.id, folder.id, { name, scanStatus: "clean" });

    const restored: string[] = [];
    for (const id of [first.id, second.id]) {
      const answer = await api(caller, `/nodes/${id}/restore`, { method: "POST", settings });
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      restored.push((answer.body as { name: string }).name);
    }
    expect(restored[0]).toMatch(/^x+ \(restored\)\.txt$/);
    expect(restored[1]).toMatch(/^x+ \(restored 2\)\.txt$/);
    for (const restoredName of restored) expect(byteLength(restoredName)).toBeLessThanOrEqual(MAX_NAME_BYTES);
  });
});

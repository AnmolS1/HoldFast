// The name an upload is renamed to on a conflict (`onConflict: "rename"`, routes/uploads.ts
// `suffixed`) stays within the name limit in BYTES of UTF-8 and never splits a character (T26
// item 6; seam authorised after Addendum 3).
import { describe, expect, it } from "vitest";
import { byteLength, MAX_NAME_BYTES } from "../../../src/worker/services/filename";
import { makeFile } from "../services-core/helpers";
import { init, uploader } from "../uploads/helpers";

const wellFormed = (text: string) => new TextDecoder().decode(new TextEncoder().encode(text)) === text;

describe("a renamed upload's name", () => {
  it.each([
    ["85 CJK characters (255 bytes)", "中".repeat(85)],
    ["62 emoji, then ab.txt (254 bytes)", `${"\u{1f600}".repeat(62)}ab.txt`],
  ])("%s → ' (n)' added, at most 255 bytes, no character split", async (_label, name) => {
    expect(byteLength(name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    const user = await uploader();
    await makeFile(user.id, null, { name, scanStatus: "clean" });
    const session = await init(user, { name, onConflict: "rename" });
    const renamed = session.finalName;
    expect(renamed).not.toBe(name);
    expect(renamed).toMatch(/ \(\d+\)(\.txt)?$/);
    expect(byteLength(renamed)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(wellFormed(renamed)).toBe(true);
  });
});

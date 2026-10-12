// The byte limits of wrangler.jsonc, in BOTH environments (the Workers project boots the top-level
// one only): decimal, like the units the product shows — "5 GB" of storage is 5,000,000,000 bytes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const config = readFileSync(fileURLToPath(new URL("../../../../wrangler.jsonc", import.meta.url)), "utf8");
const valuesOf = (name: string) =>
  [...config.matchAll(new RegExp(`"${name}":\\s*"(\\d+)"`, "g"))].map((match) => match[1]);

describe("wrangler.jsonc byte limits", () => {
  it.each([
    ["QUOTA_BYTES", "5000000000"],
    ["MAX_FILE_BYTES", "2000000000"],
    ["CEIL_UPLOAD_BYTES_DAY", "10000000000"],
    ["CEIL_IP_BYTES_DAY", "50000000000"],
  ])("%s is %s at the top level and in env.production", (name, value) => {
    expect(valuesOf(name)).toEqual([value, value]);
  });
});

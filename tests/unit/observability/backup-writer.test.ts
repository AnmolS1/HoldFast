// The nightly export's pieces that need no whole table: the part chunker, the gzip/multipart
// writer fed synthetic rows against the local bucket (isolated per test file), and the derived
// table set and order against this checkout's migrated database (catalogue reads only).
// The whole-table runs are in backup.tablewide.test.ts.
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { printableKey, SECRET_KEY_TABLES } from "../../../scripts/ops/restore-core";
import { parentsFirst, schemaTableNames, tableShapes } from "../../../src/worker/db/queries/backup";
import {
  BACKUP_PART_BYTES,
  exportOrder,
  monthOf,
  PartChunker,
  writeGzipLines,
} from "../../../src/worker/jobs/backup";
import { testDb } from "../services-core/helpers";

const MiB = 1024 * 1024;

/** Pushes `total` bytes in chunks of the given sizes (cycled) and returns every part plus the tail. */
function cut(total: number, chunkSizes: number[], size = BACKUP_PART_BYTES): Uint8Array[] {
  const chunker = new PartChunker(size);
  const parts: Uint8Array[] = [];
  let sent = 0;
  let index = 0;
  let value = 0;
  while (sent < total) {
    const length = Math.min(chunkSizes[index++ % chunkSizes.length]!, total - sent);
    const chunk = new Uint8Array(length);
    for (let i = 0; i < length; i++) chunk[i] = value++ & 0xff;
    parts.push(...chunker.push(chunk));
    sent += length;
  }
  parts.push(chunker.finish());
  return parts;
}

describe("PartChunker", () => {
  it.each([
    ["0 bytes", 0],
    ["1 byte", 1],
    ["exactly one part", BACKUP_PART_BYTES],
    ["one part + 1 byte", BACKUP_PART_BYTES + 1],
    ["several parts and a ragged tail", 3 * BACKUP_PART_BYTES + 12_345],
  ])("%s: every non-final part is the constant, and the sizes sum to the input", (_label, total) => {
    for (const chunks of [[65_536], [1, 7, 4_099_999], [BACKUP_PART_BYTES + 3], [BACKUP_PART_BYTES - 1, 2]]) {
      const parts = cut(total, chunks);
      const tail = parts[parts.length - 1]!;
      for (const part of parts.slice(0, -1)) expect(part.length).toBe(BACKUP_PART_BYTES);
      expect(tail.length).toBeLessThan(BACKUP_PART_BYTES);
      expect(parts.reduce((sum, part) => sum + part.length, 0)).toBe(total);
      // The bytes come out in order: byte i is (i mod 256).
      let i = 0;
      for (const part of parts) {
        for (const byte of part) if (byte !== (i++ & 0xff)) throw new Error(`byte ${i - 1} out of order`);
      }
    }
  });

  it("the constant is 8 MiB, at least R2's 5 MiB minimum", () => {
    expect(BACKUP_PART_BYTES).toBe(8 * MiB);
    expect(BACKUP_PART_BYTES).toBeGreaterThanOrEqual(5 * MiB);
  });
});

// ── the writer, against the local bucket ────────────────────────────────────────────────────

/** Incompressible lines: random bytes, base64 — about `bytes` of text in pages of 100 lines. */
async function* randomPages(bytes: number, lineBytes = 64 * 1024): AsyncGenerator<string[]> {
  let made = 0;
  let page: string[] = [];
  while (made < bytes) {
    const raw = crypto.getRandomValues(new Uint8Array((lineBytes * 3) / 4));
    let binary = "";
    for (const byte of raw) binary += String.fromCharCode(byte);
    page.push(JSON.stringify({ n: made, filler: btoa(binary) }));
    made += lineBytes;
    if (page.length === 100) {
      yield page;
      page = [];
    }
  }
  if (page.length) yield page;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function gunzipLines(bytes: ArrayBuffer): Promise<string[]> {
  const text = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).text();
  return text.split("\n").filter(Boolean);
}

describe("writeGzipLines", () => {
  it("a small table is one put; the object gunzips to the lines, and size and sha256 are the object's", async () => {
    const key = "b/db/2099-01-01/small.jsonl.gz";
    const lines = ['{"a":1}', '{"b":"two"}'];
    const result = await writeGzipLines(
      env.FILES,
      key,
      (async function* () {
        yield lines;
      })(),
    );
    const object = await env.FILES.get(key);
    const bytes = await object!.arrayBuffer();
    expect(result.rows).toBe(2);
    expect(result.bytes).toBe(bytes.byteLength);
    expect(result.sha256).toBe(await sha256Hex(bytes));
    expect(await gunzipLines(bytes)).toEqual(lines);
  });

  it("output past one part goes up in multipart: equal 8 MiB parts, completed, readable whole", async () => {
    const key = "b/db/2099-01-02/big.jsonl.gz";
    const result = await writeGzipLines(env.FILES, key, randomPages(24 * MiB));
    expect(result.bytes).toBeGreaterThan(2 * BACKUP_PART_BYTES);
    const bytes = await (await env.FILES.get(key))!.arrayBuffer();
    expect(bytes.byteLength).toBe(result.bytes);
    expect(result.sha256).toBe(await sha256Hex(bytes));
    const lines = await gunzipLines(bytes);
    expect(lines).toHaveLength(result.rows);
    expect(JSON.parse(lines[lines.length - 1]!).n).toBe((result.rows - 1) * 64 * 1024);
  });

  it("a part-size mistake fails at complete(): the call throws and nothing is left at the key", async () => {
    // Non-final parts under R2's 5 MiB minimum: every uploadPart succeeds, complete() refuses.
    const key = "b/db/2099-01-03/short-parts.jsonl.gz";
    await expect(
      writeGzipLines(env.FILES, key, randomPages(12 * MiB), { partBytes: 5 * MiB - 1 }),
    ).rejects.toThrow();
    expect(await env.FILES.head(key)).toBeNull();
  });

  it("a source that fails mid-way aborts the upload: nothing at the key", async () => {
    const key = "b/db/2099-01-04/failing.jsonl.gz";
    async function* failing() {
      yield* randomPages(10 * MiB);
      throw new Error("the database went away");
    }
    await expect(writeGzipLines(env.FILES, key, failing())).rejects.toThrow("the database went away");
    expect(await env.FILES.head(key)).toBeNull();
  });
});

// ── which tables, in which order ────────────────────────────────────────────────────────────

describe("the table set and the order", () => {
  it("the export covers exactly the tables of the migrated database (a new table goes red here)", async () => {
    const result = await testDb().execute<{ name: string }>(
      // The migrated database's own tables; drizzle's journal lives in its own schema.
      sql`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const database = result.rows.map((row) => row.name).sort();
    expect(schemaTableNames()).toEqual(database);
    expect(schemaTableNames()).toHaveLength(29);
    // The seven Better Auth tables are among them (spike P5's physical names).
    for (const name of [
      "user",
      "session",
      "account",
      "verification",
      "passkey",
      "two_factor",
      "rate_limit",
    ]) {
      expect(schemaTableNames()).toContain(name);
    }
  });

  it("parents first puts every table after each table it references; the export runs the reverse", async () => {
    const shapes = await tableShapes(testDb(), schemaTableNames());
    const order = parentsFirst(shapes);
    for (const [name, shape] of shapes) {
      for (const ref of shape.references) {
        if (ref !== name) expect(order.indexOf(ref), `${name} → ${ref}`).toBeLessThan(order.indexOf(name));
      }
    }
    expect(exportOrder(shapes)).toEqual([...order].reverse());
    expect(order[0]).toBe("audit_log"); // no references, first by name
    expect(shapes.get("download_ledger")!.key).toEqual(["day", "subject_type", "subject_id"]);
  });

  it("monthOf gives the month's first day and the next month's", () => {
    expect(monthOf(new Date("2099-12-31T23:59:59Z"))).toEqual({ from: "2099-12-01", to: "2100-01-01" });
    expect(monthOf(new Date("2099-03-01T00:00:00Z"))).toEqual({ from: "2099-03-01", to: "2099-04-01" });
  });
});

describe("the restore prints no secret key (review minor 3)", () => {
  it("an invite code or a blocked hash is shown as sha256:<12 hex>; other keys as they are", async () => {
    const code = "ABCDE-FGHJK-MNPQR-STUVW"; // made up
    const shown = await printableKey("invites", code);
    expect(shown).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(shown).not.toContain("ABCDE");
    expect(await printableKey("hash_blocklist", "ab".repeat(32))).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(await printableKey("nodes", "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e")).toBe(
      "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e",
    );
    expect([...SECRET_KEY_TABLES].sort()).toEqual(["hash_blocklist", "invites"]);
  });
});

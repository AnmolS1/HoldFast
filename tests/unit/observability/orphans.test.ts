// The read-only orphan listing (scripts/ops/orphans-core.ts) against the local bucket (this file's
// own: R2 is isolated per test file) and this checkout's database, with T14's own reference
// reads AND the CLI's plain-SQL copy of them — the two must list the same objects.
import { env } from "cloudflare:workers";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listOrphans, sqlReferences, type Lister } from "../../../scripts/ops/orphans-core";
import { uuidv7 } from "../../../src/worker/db/ids";
import { knownVersions, referencedKeys } from "../../../src/worker/db/queries/trash-jobs";
import { nodeVersions } from "../../../src/worker/db/schema";
import { keyFor, thumbKey } from "../../../src/worker/services/storage";
import { makeFile, makeUpload, makeUser, testDb } from "../trash/helpers";

const lister: Lister = async (prefix, cursor) => {
  const page = await env.FILES.list({ prefix, cursor: cursor ?? undefined, limit: 3 });
  return {
    objects: page.objects.map((object) => ({ key: object.key, uploaded: object.uploaded })),
    cursor: page.truncated ? page.cursor : null,
  };
};
const t14 = {
  referencedKeys: (keys: readonly string[]) => referencedKeys(testDb(), keys),
  knownVersions: (ids: readonly string[]) => knownVersions(testDb(), ids),
};

let client: pg.Client;
const keys = {} as Record<string, string>;

beforeAll(async () => {
  client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  const owner = await makeUser();
  const file = await makeFile(owner.id, null);
  const oldVersion = uuidv7();
  await testDb()
    .insert(nodeVersions)
    .values({
      nodeId: file.id,
      versionId: oldVersion,
      r2Key: keyFor(owner.id, file.id, oldVersion),
      size: 3,
      createdBy: owner.id,
      purgeAfter: new Date(Date.now() + 86_400_000),
    });
  const upload = await makeUpload(owner.id, owner.id); // status defaults to open
  keys.current = file.r2Key!;
  keys.kept = keyFor(owner.id, file.id, oldVersion);
  keys.arriving = upload.r2Key!;
  keys.stray = keyFor(owner.id, uuidv7(), uuidv7());
  keys.avatarStray = `a/${owner.id}/${uuidv7()}`;
  keys.thumbLive = thumbKey(file.id, file.versionId!, 320);
  keys.thumbKept = thumbKey(file.id, oldVersion, 320);
  keys.thumbGone = thumbKey(file.id, uuidv7(), 320);
  keys.thumbOddShape = `t/${file.id}/not-a-thumb`;
  keys.backup = "b/db/2099-01-01/nodes.jsonl.gz";
  for (const key of Object.values(keys)) await env.FILES.put(key, "x");
});

afterAll(async () => {
  await client?.end();
});

describe("listOrphans", () => {
  it("lists exactly the unreferenced objects of u/, t/ and a/ — with T14's reads and with the CLI's SQL alike", async () => {
    const future = new Date(Date.now() + 3 * 86_400_000);
    const viaT14 = await listOrphans(lister, t14, { now: future });
    const viaSql = await listOrphans(
      lister,
      sqlReferences({ query: async (text, params) => ({ rows: (await client.query(text, params)).rows }) }),
      { now: future },
    );
    const expected = [keys.stray, keys.thumbGone, keys.avatarStray].sort();
    expect(viaT14.map((orphan) => orphan.key).sort()).toEqual(expected);
    expect(viaSql).toEqual(viaT14);
    // Three days on, every one of them is past the sweep's 48 h floor.
    expect(viaT14.every((orphan) => orphan.sweepWouldDelete && orphan.ageHours >= 48)).toBe(true);
  });

  it("objects younger than 48 h are listed but marked young", async () => {
    const now = await listOrphans(lister, t14);
    expect(now.map((orphan) => orphan.key)).toContain(keys.stray);
    expect(now.every((orphan) => !orphan.sweepWouldDelete)).toBe(true);
  });

  it("deletes nothing: every object is still there", async () => {
    await listOrphans(lister, t14, { now: new Date(Date.now() + 3 * 86_400_000) });
    for (const key of Object.values(keys)) expect(await env.FILES.head(key), key).not.toBeNull();
  });
});

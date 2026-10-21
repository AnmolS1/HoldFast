// "Resolve kept upload" (T25, brief Addendum 0 14:50): an upload the SERVER proved csam whose hash
// is no longer listed stays `completing` under "keep and alert" until an operator acts — re-list
// the hash (a confirmed, permanent csam listing; the repair sweep then locks it) or end it as a
// confirmed false positive (the object deleted, refused while held or paused: PLAN §6 rule 17).
//
// The session is built as T22's route leaves it (tests/unit/abuse/owed-sweep.tablewide.test.ts):
// `completing` an hour ago, the server's hash on `expected_sha256`, the route's
// `upload.csam_node_owed` audit row, its object stored and its reservation on the owner.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeptUploadPage, ResolveKeptUploadResponse } from "../../../src/shared/schemas/admin";
import { uuidv7 } from "../../../src/worker/db/ids";
import { auditLog, uploads, user } from "../../../src/worker/db/schema";
import { DESTROY_PAUSED_KEY } from "../../../src/worker/jobs/reconcile";
import { keyFor } from "../../../src/worker/services/storage";
import { generationInStep, objectExists } from "../trash/helpers";
import {
  admin,
  adminCall,
  auditOf,
  blocklistRow,
  madeUpSha,
  member,
  rand,
  testDb,
  userRowOf,
} from "./helpers";

const SIZE = 500;
const LONG_AGO = new Date(Date.now() - 3 * 3_600_000);

beforeAll(async () => {
  await generationInStep();
});
afterEach(async () => {
  await env.FILES.delete(DESTROY_PAUSED_KEY);
});

async function kept(opts: { ownerHeld?: boolean; uploaderHeld?: boolean } = {}) {
  const owner = await member({ legalHold: opts.ownerHeld === true, usedBytes: SIZE });
  const uploader = opts.uploaderHeld ? await member({ legalHold: true }) : owner;
  const sha256 = madeUpSha();
  const nodeId = uuidv7();
  const versionId = uuidv7();
  const r2Key = keyFor(owner.id, nodeId, versionId);
  const name = `kept-${rand()}.bin`;
  const [session] = await testDb()
    .insert(uploads)
    .values({
      ownerId: owner.id,
      uploaderId: uploader.id,
      parentId: null,
      nodeId,
      versionId,
      name,
      nameKey: name,
      size: SIZE,
      r2Key,
      expiresAt: new Date(Date.now() + 3_600_000),
      status: "completing",
      completingAt: LONG_AGO,
      expectedSha256: sha256,
    })
    .returning();
  await env.FILES.put(r2Key, "verified bytes");
  await testDb().insert(auditLog).values({
    actorType: "system",
    action: "upload.csam_node_owed",
    targetType: "upload",
    targetId: session!.id,
    meta: { nodeId },
  });
  return { owner, uploader, session: session!, sha256 };
}

const sessionOf = async (id: string) => (await testDb().select().from(uploads).where(eq(uploads.id, id)))[0]!;
const resolve = (body: Record<string, unknown>) => ({
  body: { reason: "NCMEC answered in writing.", ...body },
});

async function listed(who: Awaited<ReturnType<typeof admin>>, uploadId: string) {
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages++) {
    const page = await adminCall(
      who.as,
      "GET",
      `/kept-uploads?limit=200${cursor ? `&cursor=${cursor}` : ""}`,
    );
    expect(page.status).toBe(200);
    expect(KeptUploadPage.safeParse(page.body).success).toBe(true);
    const hit = page.body.items.find((item: { uploadId: string }) => item.uploadId === uploadId);
    if (hit) return hit;
    cursor = page.body.nextCursor;
    if (!cursor) return null;
  }
  return null;
}

describe("the list", () => {
  it("a kept session is listed with its (unlisted) hash", async () => {
    const who = await admin();
    const t = await kept();
    expect(await listed(who, t.session.id)).toMatchObject({
      sha256: t.sha256,
      listedAs: null,
      ownerId: t.owner.id,
    });
  });
});

describe("re-list the hash", () => {
  it("the preview changes nothing; the confirm makes the hash a CONFIRMED csam listing, audited; the session is left for the sweep", async () => {
    const who = await admin();
    const t = await kept();
    const preview = await adminCall(
      who.as,
      "POST",
      `/kept-uploads/${t.session.id}/resolve`,
      resolve({ resolution: "relist" }),
    );
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ confirmed: false, ended: false });
    expect(await blocklistRow(t.sha256)).toBeNull();
    expect(await auditOf("admin.kept_upload_relisted", t.session.id)).toHaveLength(0);

    const done = await adminCall(
      who.as,
      "POST",
      `/kept-uploads/${t.session.id}/resolve`,
      resolve({ resolution: "relist", confirm: true }),
    );
    expect(done.status).toBe(200);
    expect(ResolveKeptUploadResponse.safeParse(done.body).success).toBe(true);
    expect(done.body).toMatchObject({ confirmed: true, ended: false, upload: { listedAs: "csam" } });
    expect(await blocklistRow(t.sha256)).toMatchObject({
      reason: "csam",
      sourceNodeId: null,
      raisedFrom: null,
      raisedByNodeId: null,
      addedBy: who.id,
    });
    const rows = await auditOf("admin.kept_upload_relisted", t.session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: who.id, actorType: "admin" });
    expect((await sessionOf(t.session.id)).status).toBe("completing");
    expect(await objectExists(t.session.r2Key)).toBe(true);
  });
});

describe("end it as a confirmed false positive", () => {
  it("the preview changes nothing", async () => {
    const who = await admin();
    const t = await kept();
    const preview = await adminCall(
      who.as,
      "POST",
      `/kept-uploads/${t.session.id}/resolve`,
      resolve({ resolution: "false_positive" }),
    );
    expect(preview.body).toMatchObject({ confirmed: false, ended: false });
    expect((await sessionOf(t.session.id)).status).toBe("completing");
    expect(await objectExists(t.session.r2Key)).toBe(true);
  });

  it.each([
    ["the owner", { ownerHeld: true }],
    ["the uploader", { uploaderHeld: true }],
  ])("refused while %s is on legal hold: 409 held, nothing changed", async (_who, opts) => {
    const who = await admin();
    const t = await kept(opts);
    for (const confirm of [undefined, true]) {
      const answer = await adminCall(
        who.as,
        "POST",
        `/kept-uploads/${t.session.id}/resolve`,
        resolve({ resolution: "false_positive", ...(confirm ? { confirm } : {}) }),
      );
      expect(answer.status).toBe(409);
      expect(answer.body.details.reason).toBe("held");
    }
    expect((await sessionOf(t.session.id)).status).toBe("completing");
    expect(await objectExists(t.session.r2Key)).toBe(true);
    expect(await auditOf("admin.kept_upload_ended", t.session.id)).toHaveLength(0);
  });

  it("refused while the pause switch is on: 409 destroy_paused, the session and its object kept", async () => {
    const who = await admin();
    const t = await kept();
    await env.FILES.put(DESTROY_PAUSED_KEY, "paused by a test");
    const answer = await adminCall(
      who.as,
      "POST",
      `/kept-uploads/${t.session.id}/resolve`,
      resolve({ resolution: "false_positive", confirm: true }),
    );
    expect(answer.status).toBe(409);
    expect(answer.body.details.reason).toBe("destroy_paused");
    expect((await sessionOf(t.session.id)).status).toBe("completing");
    expect(await objectExists(t.session.r2Key)).toBe(true);
    expect((await userRowOf(t.owner.id))!.usedBytes).toBe(SIZE);
  });

  it("control: in step and unpaused — the session aborted, the reservation released, the object deleted, audited", async () => {
    const who = await admin();
    const t = await kept();
    const answer = await adminCall(
      who.as,
      "POST",
      `/kept-uploads/${t.session.id}/resolve`,
      resolve({ resolution: "false_positive", confirm: true }),
    );
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ confirmed: true, ended: true });
    expect((await sessionOf(t.session.id)).status).toBe("aborted");
    expect(await objectExists(t.session.r2Key)).toBe(false);
    const [owner] = await testDb()
      .select({ usedBytes: user.usedBytes })
      .from(user)
      .where(eq(user.id, t.owner.id));
    expect(owner!.usedBytes).toBe(0);
    const rows = await auditOf("admin.kept_upload_ended", t.session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({ as: "aborted", objectDeleted: true });
    // A second confirm finds nothing kept any more.
    const again = await adminCall(
      who.as,
      "POST",
      `/kept-uploads/${t.session.id}/resolve`,
      resolve({ resolution: "false_positive", confirm: true }),
    );
    expect(again.status).toBe(404);
  });
});

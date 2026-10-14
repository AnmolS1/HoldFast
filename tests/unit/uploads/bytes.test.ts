// The bytes: one PUT for a single session, uniform parts for a multipart one — streamed to the
// store with the declared length, and (single) through the gate that keeps a late PUT from
// replacing an object that has been completed.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIN_PART_BYTES, PART_BYTES } from "../../../src/shared/constants";
import { NodeDto } from "../../../src/shared/schemas/node";
import {
  InitUploadResponse,
  OpenUploadsResponse,
  PartResponse,
  SinglePutResponse,
} from "../../../src/shared/schemas/upload";
import * as sessions from "../../../src/worker/db/queries/upload-sessions";
import { claimCompleting } from "../../../src/worker/db/queries/uploads";
import { uploadParts } from "../../../src/worker/db/schema";
import { storedSha256 } from "../../../src/worker/routes/uploads";
import { keyFor, storage } from "../../../src/worker/services/storage";
import { SPARSE_FILE_BYTES } from "../../setup/fixture-bytes";
import { deliver, gate, nodeById, testDb } from "../services-core/helpers";
import {
  call,
  complete,
  init,
  initBody,
  ledgerOf,
  MIB,
  partRows,
  putSingle,
  sessionRow,
  sha,
  TWO_PARTS,
  uploaded,
  uploader,
  usedBytes,
  zeros,
} from "./helpers";

const bytesOf = async (key: string) => new Uint8Array(await (await env.FILES.get(key))!.arrayBuffer());
const filled = (size: number, value: number) => new Uint8Array(size).fill(value);

describe("PUT /uploads/:id/single", () => {
  it("stores the body under the session's key and answers { etag }", async () => {
    const user = await uploader();
    const session = await init(user, { size: 3000 });
    const content = filled(3000, 7);
    const answer = await putSingle(user, session.uploadId, content);
    expect(answer.status).toBe(200);
    const { etag } = SinglePutResponse.parse(answer.body);
    const row = (await sessionRow(session.uploadId))!;
    const head = (await env.FILES.head(row.r2Key))!;
    expect(head.etag).toBe(etag);
    expect(head.size).toBe(3000);
    expect(head.httpMetadata?.contentType).toBe("application/octet-stream");
    expect(head.customMetadata).toEqual({ nodeId: row.nodeId, ownerId: user.id });
    expect(await bytesOf(row.r2Key)).toEqual(content);
    expect(await partRows(session.uploadId)).toEqual([
      { uploadId: session.uploadId, partNumber: 1, etag, size: 3000 },
    ]);
    const open = OpenUploadsResponse.parse((await call(user, "GET", "/uploads/open")).body);
    expect(open[0]).toMatchObject({ uploadId: session.uploadId, uploadedParts: 1, partCount: 1 });
    // While the session is open the file may be sent again.
    const again = await putSingle(user, session.uploadId, filled(3000, 8));
    expect(again.status).toBe(200);
    expect((await bytesOf(row.r2Key))[0]).toBe(8);
  });

  it("the declared length must be the session's size, and the body must be that long — else nothing is stored", async () => {
    const user = await uploader();
    const session = await init(user, { size: 3000 });
    const key = (await sessionRow(session.uploadId))!.r2Key;
    const path = `/uploads/${session.uploadId}/single`;
    for (const options of [
      { body: new Uint8Array(2999) },
      { body: new Uint8Array(3001) },
      { body: zeros(3000), contentLength: null },
      { body: zeros(3000), contentLength: 2999 },
      {},
    ]) {
      const answer = await call(user, "PUT", path, options);
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe("validation");
    }
    // A body that lies about its length: shorter and longer than declared.
    for (const actual of [2000, 4000]) {
      const answer = await call(user, "PUT", path, { body: zeros(actual), contentLength: 3000 });
      expect(answer.status, String(actual)).toBe(400);
      expect(answer.body).toMatchObject({ error: "validation", details: { reason: "content_length" } });
    }
    expect(await env.FILES.head(key)).toBeNull();
    expect(await partRows(session.uploadId)).toHaveLength(0);
    expect((await complete(user, session.uploadId)).status).toBe(400);
    expect((await sessionRow(session.uploadId))?.status).toBe("open");
    // The session is still usable.
    expect((await putSingle(user, session.uploadId, new Uint8Array(3000))).status).toBe(200);
  });

  it("an empty file is one PUT of nothing", async () => {
    const user = await uploader();
    const session = await init(user, { size: 0 });
    const put = await call(user, "PUT", `/uploads/${session.uploadId}/single`, { contentLength: 0 });
    expect(put.status).toBe(200);
    const done = await complete(user, session.uploadId);
    expect(done.status).toBe(201);
    expect(NodeDto.parse(done.body)).toMatchObject({ size: 0, scanStatus: "pending" });
  });

  it("is refused for a multipart session, as parts are for a single one", async () => {
    const user = await uploader();
    const multi = await init(user, { size: TWO_PARTS });
    const single = await init(user, { size: 1000 });
    const one = await call(user, "PUT", `/uploads/${multi.uploadId}/single`, {
      body: zeros(8),
      contentLength: TWO_PARTS,
    });
    expect(one.status).toBe(400);
    const part = await call(user, "PUT", `/uploads/${single.uploadId}/parts/1`, {
      body: new Uint8Array(1000),
    });
    expect(part.status).toBe(400);
    expect(await env.FILES.head((await sessionRow(single.uploadId))!.r2Key)).toBeNull();
    await call(user, "DELETE", `/uploads/${multi.uploadId}`);
  });
});

describe("the gate of a single PUT: after complete nothing a client sends changes the bytes", () => {
  /** A body whose second half is held back until the test lets it go. */
  function heldBody(content: Uint8Array) {
    const started = gate();
    const release = gate();
    let step = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (step++ === 0) {
          controller.enqueue(content.subarray(0, content.length / 2));
          started.open();
          return;
        }
        await release.opened;
        controller.enqueue(content.subarray(content.length / 2));
        controller.close();
      },
    });
    return { stream, started: started.opened, release: release.open };
  }

  it("a PUT still streaming when the session is completed stores nothing: the scanned object stays", async () => {
    const user = await uploader();
    const session = await init(user, { size: 4000 });
    const key = (await sessionRow(session.uploadId))!.r2Key;
    const late = heldBody(filled(4000, 0xbb));
    // The late PUT starts while the session is open …
    const latePut = call(user, "PUT", `/uploads/${session.uploadId}/single`, {
      body: late.stream,
      contentLength: 4000,
    });
    await late.started;
    // … the honest one finishes, the session is completed and its object scanned …
    expect((await putSingle(user, session.uploadId, filled(4000, 0xaa))).status).toBe(200);
    const sent: unknown[] = [];
    const done = await complete(user, session.uploadId, {}, { sent });
    expect(done.status).toBe(201);
    expect(await deliver([{ body: sent[0] }])).toEqual([{ outcome: "ack" }]);
    const node = (await nodeById(String(done.body.id)))!;
    expect(node.scanStatus).toBe("clean");
    // … and now the late PUT delivers its last byte.
    late.release();
    const answer = await latePut;
    expect(answer.status).toBe(409);
    expect(await bytesOf(key)).toEqual(filled(4000, 0xaa));
    expect((await env.FILES.head(key))!.etag).toBe((await partRows(session.uploadId))[0]!.etag);
    expect(await nodeById(node.id)).toMatchObject({ scanStatus: "clean", r2Key: key });
  });

  it("a second PUT on a completing or done session is refused before a byte is read", async () => {
    const user = await uploader();
    const session = await uploaded(user, {}, filled(1000, 1));
    const key = (await sessionRow(session.uploadId))!.r2Key;
    expect((await complete(user, session.uploadId)).status).toBe(201);
    expect((await putSingle(user, session.uploadId, filled(1000, 2))).status).toBe(409);
    expect(await bytesOf(key)).toEqual(filled(1000, 1));

    const claimed = await uploaded(user, {}, filled(1000, 3));
    await claimCompleting(testDb(), claimed.uploadId, user.id);
    expect((await putSingle(user, claimed.uploadId, filled(1000, 4))).status).toBe(409);
    expect(await bytesOf((await sessionRow(claimed.uploadId))!.r2Key)).toEqual(filled(1000, 3));
  });

  it("the gate and the claim happen one after the other, whichever comes first", async () => {
    const user = await uploader();
    // The gate first: the claim that follows sees a PUT committing.
    const a = await init(user);
    expect(await sessions.beginSinglePut(testDb(), a.uploadId, "token-a")).toBe(true);
    expect(await claimCompleting(testDb(), a.uploadId, user.id)).not.toBeNull();
    const marker = (await sessions.listParts(testDb(), a.uploadId))[0]!;
    expect(sessions.isCommitting(marker.etag)).toBe(true);
    // The claim first: the gate is closed.
    const b = await init(user);
    expect(await claimCompleting(testDb(), b.uploadId, user.id)).not.toBeNull();
    expect(await sessions.beginSinglePut(testDb(), b.uploadId, "token-b")).toBe(false);
    expect(await sessions.listParts(testDb(), b.uploadId)).toHaveLength(0);
    // Both at once, many times: never "the gate passed" without the claimant seeing it.
    for (let round = 0; round < 25; round++) {
      const racer = await uploader();
      const s = await init(racer);
      const [passed, claimed] = await Promise.all([
        sessions.beginSinglePut(testDb(), s.uploadId, `t${round}`),
        claimCompleting(testDb(), s.uploadId, racer.id),
      ]);
      expect(claimed).not.toBeNull();
      const seen = await sessions.listParts(testDb(), s.uploadId);
      expect(seen.some((part) => sessions.isCommitting(part.etag))).toBe(passed);
    }
  });

  it("while one PUT is committing another is refused and complete says 'not uploaded'; a marker left by a dead invocation is taken over after ten minutes", async () => {
    const user = await uploader();
    const session = await init(user, { size: 1000 });
    const key = (await sessionRow(session.uploadId))!.r2Key;
    expect(await sessions.beginSinglePut(testDb(), session.uploadId, "first")).toBe(true);
    expect(await sessions.beginSinglePut(testDb(), session.uploadId, "second")).toBe(false);
    const refused = await putSingle(user, session.uploadId, filled(1000, 5));
    expect(refused.status).toBe(409);
    expect(await env.FILES.head(key)).toBeNull();
    const early = await complete(user, session.uploadId);
    expect(early.status).toBe(400);
    expect((await sessionRow(session.uploadId))?.status).toBe("open");
    // The marker says when it was set; eleven minutes ago is a dead invocation.
    const stale = `committing:first:${Date.now() - 11 * 60_000}`;
    await testDb().update(uploadParts).set({ etag: stale }).where(eq(uploadParts.uploadId, session.uploadId));
    expect((await putSingle(user, session.uploadId, filled(1000, 6))).status).toBe(200);
    // Its own end no longer counts: the marker is not its any more.
    expect(
      await sessions.finishSinglePut(testDb(), session.uploadId, "first", { etag: "x", size: 1000 }),
    ).toBe(false);
    expect((await complete(user, session.uploadId)).status).toBe(201);
    expect(await bytesOf(key)).toEqual(filled(1000, 6));
  });

  it("complete refuses an object that is not the one the last PUT stored", async () => {
    const user = await uploader();
    const session = await uploaded(user, {}, filled(1000, 1));
    const row = (await sessionRow(session.uploadId))!;
    // Written past the route (what a PUT that slipped the gate would do).
    await env.FILES.put(row.r2Key, filled(1000, 9));
    const answer = await complete(user, session.uploadId);
    expect(answer.status).toBe(400);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted" });
    expect(await usedBytes(user.id)).toBe(0);
    expect(await env.FILES.head(row.r2Key)).toBeNull();
  });
});

describe("PUT /uploads/:id/parts/:n", () => {
  it("accepts only the uniform plan: every part PART_BYTES, the last what is left; the part number within the count", async () => {
    const user = await uploader();
    const size = SPARSE_FILE_BYTES;
    const session = await init(user, { size });
    const last = size - 2 * PART_BYTES;
    expect([session.partCount, last]).toEqual([3, 5_782_272]);
    const put = (n: number | string, contentLength: number | null) =>
      call(user, "PUT", `/uploads/${session.uploadId}/parts/${n}`, { body: zeros(16), contentLength });
    for (const [n, length] of [
      [1, PART_BYTES - 1],
      [1, PART_BYTES + 1],
      [1, MIN_PART_BYTES],
      [2, last],
      [3, PART_BYTES],
      [3, last + 1],
      [3, last - 1],
      [0, PART_BYTES],
      [4, last],
      [4, PART_BYTES],
      [1, null],
    ] as const) {
      const answer = await put(n, length);
      expect(answer.status, `${n}:${length}`).toBe(400);
      expect(answer.body.error).toBe("validation");
    }
    expect((await put("99999", PART_BYTES)).status).toBe(400);
    expect((await put("100000", PART_BYTES)).status).toBe(404);
    // A body that is not as long as it says stores no part.
    const short = await call(user, "PUT", `/uploads/${session.uploadId}/parts/3`, {
      body: zeros(last - 5),
      contentLength: last,
    });
    expect(short.status).toBe(400);
    expect(short.body).toMatchObject({ error: "validation", details: { reason: "content_length" } });
    expect(await partRows(session.uploadId)).toHaveLength(0);
    await call(user, "DELETE", `/uploads/${session.uploadId}`);
  });

  it("the 140,000,000-byte file: three parts, resumed half-way, one part sent again, completed into one node", async () => {
    const user = await uploader();
    const size = SPARSE_FILE_BYTES;
    const body = initBody({ size, name: "sparse.bin" });
    const first = await call(user, "POST", "/uploads", { json: body });
    const session = InitUploadResponse.parse(first.body);
    expect(session).toMatchObject({ mode: "multipart", partBytes: PART_BYTES, partCount: 3 });
    const last = size - 2 * PART_BYTES;

    const sendPart = async (n: number, stream: ReadableStream<Uint8Array>, length: number) => {
      const answer = await call(user, "PUT", `/uploads/${session.uploadId}/parts/${n}`, {
        body: stream,
        contentLength: length,
      });
      expect(answer.status).toBe(200);
      return PartResponse.parse(answer.body);
    };
    const one = await sendPart(1, zeros(PART_BYTES), PART_BYTES);
    const two = await sendPart(2, zeros(PART_BYTES), PART_BYTES);
    expect(one).toEqual({ n: 1, etag: expect.any(String) });

    // A reload: the same file again gets the same session and what the server already has.
    const resumed = await call(user, "POST", "/uploads", { json: body });
    expect(resumed.status).toBe(200);
    expect(InitUploadResponse.parse(resumed.body)).toEqual({ ...session, resumedParts: [one, two] });
    expect(await usedBytes(user.id)).toBe(size);
    const open = OpenUploadsResponse.parse((await call(user, "GET", "/uploads/open")).body);
    expect(open[0]).toMatchObject({ uploadId: session.uploadId, uploadedParts: 2, partCount: 3 });

    // Completing with a part missing leaves the session open.
    const early = await complete(user, session.uploadId, { parts: [one, two] });
    expect(early.status).toBe(400);

    // The last part, then the same part again with other bytes: the row is replaced.
    const ones = () =>
      zeros(last).pipeThrough(new TransformStream({ transform: (c, ctl) => ctl.enqueue(c.map(() => 1)) }));
    const three = await sendPart(3, zeros(last), last);
    const threeAgain = await sendPart(3, ones(), last);
    expect(threeAgain.etag).not.toBe(three.etag);
    expect((await partRows(session.uploadId)).map((row) => [row.partNumber, row.etag, row.size])).toEqual([
      [1, one.etag, PART_BYTES],
      [2, two.etag, PART_BYTES],
      [3, threeAgain.etag, last],
    ]);

    // Parts by mode, and parts that are not what was uploaded: 400, and the session stays open.
    for (const parts of [
      [],
      [one, two, three],
      [one, two, threeAgain, { n: 4, etag: "x" }],
      [one, one, threeAgain],
    ]) {
      const answer = await complete(user, session.uploadId, { parts });
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe("validation");
      expect((await sessionRow(session.uploadId))?.status).toBe("open");
    }

    const sent: unknown[] = [];
    const sha256 = sha();
    const done = await complete(user, session.uploadId, { sha256, parts: [threeAgain, one, two] }, { sent });
    expect(done.status).toBe(201);
    const node = NodeDto.parse(done.body);
    expect(node).toMatchObject({
      name: "sparse.bin",
      size,
      scanStatus: "pending",
      sha256: null,
      role: "owner",
    });
    expect((await nodeById(node.id))?.sha256).toBe(sha256);
    const row = (await sessionRow(session.uploadId))!;
    expect(row.status).toBe("done");
    const head = (await env.FILES.head(row.r2Key))!;
    expect(head.size).toBe(size);
    expect(head.etag.endsWith("-3")).toBe(true);
    expect(row.r2Key).toBe(keyFor(user.id, node.id, row.versionId));
    expect(sent).toEqual([{ v: 1, nodeId: node.id, key: row.r2Key, force: false }]);
    expect(await usedBytes(user.id)).toBe(size);
    expect(await ledgerOf("upload_user", user.id)).toMatchObject([{ bytes: size, count: 1 }]);
    // The tail of the object is the part that was sent last.
    const tail = await env.FILES.get(row.r2Key, { range: { suffix: 4 } });
    expect(new Uint8Array(await tail!.arrayBuffer())).toEqual(filled(4, 1));
    // What a blocklist hit costs at this size: the server's own hash of the stored object.
    const hashed = await storedSha256(storage(env), row.r2Key);
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    // Nothing more is taken for it.
    const late = await call(user, "PUT", `/uploads/${session.uploadId}/parts/3`, {
      body: zeros(last),
      contentLength: last,
    });
    expect(late.status).toBe(409);
    expect((await env.FILES.head(row.r2Key))!.etag).toBe(head.etag);
  }, 120_000);

  it("a single session completes with parts: [] — and not with a part", async () => {
    const user = await uploader();
    const session = await uploaded(user, { size: 1000 });
    const withPart = await complete(user, session.uploadId, { parts: [{ n: 1, etag: "abc" }] });
    expect(withPart.status).toBe(400);
    expect(withPart.body.error).toBe("validation");
    expect((await sessionRow(session.uploadId))?.status).toBe("open");
    const done = await complete(user, session.uploadId, { parts: [] });
    expect(done.status).toBe(201);
    expect(NodeDto.parse(done.body).scanStatus).toBe("pending");
  });
});

describe("the store's part rules (checked by it only at complete)", () => {
  it("unequal non-final parts → 10048, a non-final part under 5 MiB → 10011 — which is why the route issues one size", async () => {
    const store = storage(env);
    const key = () => keyFor("a".repeat(32), crypto.randomUUID(), crypto.randomUUID());
    const part = (mpu: R2MultipartUpload, n: number, size: number) =>
      store.uploadPart(mpu, n, zeros(size), size);

    const unequal = await store.createMultipart(key());
    const a = [await part(unequal, 1, 6 * MIB), await part(unequal, 2, 7 * MIB), await part(unequal, 3, MIB)];
    await expect(store.complete(unequal, a)).rejects.toThrow(/10048/);
    await store.abort(unequal);

    const small = await store.createMultipart(key());
    const b = [await part(small, 1, MIB), await part(small, 2, MIB)];
    await expect(store.complete(small, b)).rejects.toThrow(/10011/);
    await store.abort(small);
  });
});

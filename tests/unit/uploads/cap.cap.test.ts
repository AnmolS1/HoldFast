// The cap-sized upload: 2,000,000,000 bytes in 30 parts through the real routes, into the local
// object store. About 2 GB in $TMPDIR while it runs — so it runs only when asked for
// (HOLDFAST_CAP_TESTS=1, through `heavy.sh cap`): one such run on the machine at a time.
//
// What it proves: the 30-part path and the size arithmetic at the cap. What it cannot prove:
// that nothing is buffered — local workerd does not enforce the deployed memory limit.
import { env } from "cloudflare:workers";
import { describe, expect, inject, it } from "vitest";
import { PART_BYTES } from "../../../src/shared/constants";
import { NodeDto } from "../../../src/shared/schemas/node";
import { storedSha256 } from "../../../src/worker/routes/uploads";
import { storage } from "../../../src/worker/services/storage";
import { call, complete, GB, init, sessionRow, uploader, usedBytes, zeros } from "./helpers";

const CAP = 2_000_000_000;

describe.skipIf(!inject("capTests"))("the cap-sized upload", () => {
  it("2,000,000,000 bytes: 30 parts, one object of exactly that size, one node", async () => {
    expect(env.MAX_FILE_BYTES).toBe(String(CAP));
    const user = await uploader({ quotaBytes: 3 * GB });
    const started = Date.now();
    const session = await init(user, { size: CAP, name: "cap.bin" });
    expect(session).toMatchObject({ mode: "multipart", partBytes: PART_BYTES, partCount: 30 });

    const parts: { n: number; etag: string }[] = [];
    for (let n = 1; n <= session.partCount; n++) {
      const length = n < session.partCount ? PART_BYTES : CAP - 29 * PART_BYTES;
      const answer = await call<{ n: number; etag: string }>(
        user,
        "PUT",
        `/uploads/${session.uploadId}/parts/${n}`,
        { body: zeros(length), contentLength: length },
      );
      expect(answer.status, `part ${n}`).toBe(200);
      parts.push(answer.body);
    }
    expect(parts).toHaveLength(30);
    expect(CAP - 29 * PART_BYTES).toBe(53_842_944);

    const done = await complete(user, session.uploadId, { parts });
    const wallMs = Date.now() - started;
    expect(done.status).toBe(201);
    expect(NodeDto.parse(done.body)).toMatchObject({ size: CAP, scanStatus: "pending" });
    const row = (await sessionRow(session.uploadId))!;
    const head = (await env.FILES.head(row.r2Key))!;
    expect(head.size).toBe(CAP);
    expect(head.etag.endsWith("-30")).toBe(true);
    expect(await usedBytes(user.id)).toBe(CAP);

    // What a blocklist hit would cost at this size: the server's own hash of the stored object.
    const hashStarted = Date.now();
    const sha256 = await storedSha256(storage(env), row.r2Key);
    const hashMs = Date.now() - hashStarted;
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    console.log(
      `T12 CAP parts=${parts.length} bytes=${head.size} uploadWallMs=${wallMs} sha256WallMs=${hashMs}`,
    );

    await env.FILES.delete(row.r2Key);
  }, 900_000);
});

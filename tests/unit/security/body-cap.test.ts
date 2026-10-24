// R1 secweb-1 (with secsrv-n10, secweb-n6): a JSON request body is read up to a byte cap, and a
// validation answer names at most the first issues — so neither the memory a request costs nor
// the size of its answer grows with what an anonymous sender puts in the body.
//
//   - `jsonBody` refuses a body over its cap (64 KiB unless the route asks for more) with
//     `413 body_too_large`, by declared length without reading it, and by a running count of the
//     bytes read when no length is declared (or a wrong one is).
//   - Every validation answer (`links.ts parse`, `nodes.ts parse`, a thrown ZodError) carries at
//     most `MAX_ECHOED_ISSUES` issues and the total in `issueCount`.
//   - `POST /api/public/links/:token/download-urls` resolves the link before it validates the
//     body: an unknown token is 404, and links off is 423, whatever the body holds.
//
// Every link password and address here is made up.
import { describe, expect, it } from "vitest";
import {
  DMCA_NOTICE_BODY_MAX_BYTES,
  JSON_BODY_MAX_BYTES,
  UPLOAD_COMPLETE_BODY_MAX_BYTES,
} from "../../../src/worker/services/body";
import { MAX_ECHOED_ISSUES } from "../../../src/worker/services/errors";
import { api, asCaller, errorOf, makeFile, makeFolder, member, settingsWith } from "../sharing/helpers";
import { linkTo, visit } from "../sharing/public-helpers";
import { admin, adminCall } from "../admin/helpers";
import { complete, init, uploader } from "../uploads/helpers";

const UNKNOWN_TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";

/** `n` array elements that each fail the element schema (a number where a uuid belongs). */
const badIds = (n: number) => Array.from({ length: n }, () => 1);

/** A string that makes the JSON body about `bytes` long. */
const padding = (bytes: number) => "x".repeat(bytes);

const sizeOf = (answer: { body: unknown }) => JSON.stringify(answer.body).length;

async function folderLink() {
  const owner = await member();
  const folder = await makeFolder(owner.id);
  const file = await makeFile(owner.id, folder.id, { scanStatus: "clean", name: "doc.txt", size: 10 });
  const link = await linkTo(owner, folder.id);
  return { owner, folder, file, link };
}

describe("a JSON body has a byte cap", () => {
  it("an anonymous body over the cap is 413 body_too_large, counted as it is read (no length declared)", async () => {
    const answer = await api(null, "/public/report", {
      json: { details: padding(JSON_BODY_MAX_BYTES + 1) },
    });
    expect(answer.status).toBe(413);
    expect(errorOf(answer)).toMatchObject({
      error: "body_too_large",
      details: { maxBytes: JSON_BODY_MAX_BYTES },
    });
  });

  it("a declared Content-Length over the cap is 413 before a byte is read", async () => {
    const answer = await api(null, "/public/report", {
      json: { details: "short" },
      headers: { "content-length": String(JSON_BODY_MAX_BYTES + 1) },
    });
    expect(answer.status).toBe(413);
    expect(errorOf(answer).error).toBe("body_too_large");
  });

  it("a body just under the cap is read and validated as before (400 validation, not 413)", async () => {
    const answer = await api(null, "/public/report", {
      json: { details: padding(JSON_BODY_MAX_BYTES - 100) },
    });
    expect(answer.status).toBe(400);
    expect(errorOf(answer).error).toBe("validation");
  });

  it("an empty or non-JSON body is still 400 validation malformed_json", async () => {
    const empty = await api(null, "/public/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(empty.status).toBe(400);
    expect(errorOf(empty).details).toMatchObject({ reason: "malformed_json" });
  });

  it("an authenticated route has the same cap", async () => {
    const owner = await member();
    const answer = await api(asCaller(owner), "/nodes/download-urls", {
      json: { nodeIds: badIds(40_000) },
    });
    expect(answer.status).toBe(413);
    expect(errorOf(answer).error).toBe("body_too_large");
  });
});

describe("a validation answer echoes at most the first issues", () => {
  it("nodes.ts parse: 10,000 bad ids → ≤ MAX_ECHOED_ISSUES issues, the total in issueCount, a small body", async () => {
    const owner = await member();
    const answer = await api(asCaller(owner), "/nodes/download-urls", { json: { nodeIds: badIds(10_000) } });
    expect(answer.status).toBe(400);
    const details = errorOf(answer).details as { issues: unknown[]; issueCount: number };
    expect(details.issues.length).toBe(MAX_ECHOED_ISSUES);
    expect(details.issueCount).toBeGreaterThan(MAX_ECHOED_ISSUES);
    expect(sizeOf(answer)).toBeLessThan(16_384);
  });

  it("links.ts parse (a public route): 10,000 bad ids under a real link → a small 400", async () => {
    const { link } = await folderLink();
    const answer = await visit(link.token, "/download-urls", {
      json: { zipGrant: "made-up", nodeIds: badIds(10_000) },
    });
    expect(answer.status).toBe(400);
    expect((errorOf(answer).details as { issues: unknown[] }).issues.length).toBeLessThanOrEqual(
      MAX_ECHOED_ISSUES,
    );
    expect(sizeOf(answer)).toBeLessThan(16_384);
  });

  it("a thrown ZodError (errors.ts): few issues are echoed in full, with their count", async () => {
    const answer = await api(null, "/public/report", { json: { details: 5 } });
    expect(answer.status).toBe(400);
    const details = errorOf(answer).details as { issues: unknown[]; issueCount: number };
    expect(details.issues.length).toBe(details.issueCount);
    expect(details.issueCount).toBeLessThanOrEqual(MAX_ECHOED_ISSUES);
  });
});

describe("public download-urls resolves the link before it validates the body", () => {
  it("an unknown token is 404 whatever the body", async () => {
    const answer = await visit(UNKNOWN_TOKEN, "/download-urls", {
      json: { zipGrant: "x", nodeIds: badIds(10_000) },
    });
    expect(answer.status).toBe(404);
    expect(errorOf(answer).error).toBe("not_found");
    expect(sizeOf(answer)).toBeLessThan(1_024);
  });

  it("links off is 423 whatever the body", async () => {
    const { link } = await folderLink();
    const answer = await visit(link.token, "/download-urls", {
      json: { zipGrant: "x", nodeIds: badIds(10_000) },
      settings: settingsWith({ linksEnabled: false }),
    });
    expect([answer.status, errorOf(answer).error]).toEqual([423, "link_paused"]);
  });
});

describe("the routes whose legitimate bodies are larger ask for a larger cap", () => {
  /** `n` parts as the client sends them: R2's quoted 32-hex etags. */
  const parts = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ n: i + 1, etag: `"${"0123456789abcdef".repeat(2)}"` }));
  /** CJK text: 3 bytes of UTF-8 for each character zod counts. */
  const cjk = (chars: number) => "\u6587".repeat(chars);

  it("upload complete: 10,000 parts (well over 64 KiB) are read; past its own cap it is 413", async () => {
    const user = await uploader();
    const session = await init(user);
    expect(JSON.stringify({ parts: parts(10_000) }).length).toBeGreaterThan(JSON_BODY_MAX_BYTES);
    const full = await complete(user, session.uploadId, { parts: parts(10_000) });
    expect(full.status).not.toBe(413);
    const over = await complete(user, session.uploadId, {
      parts: [{ n: 1, etag: "x".repeat(UPLOAD_COMPLETE_BODY_MAX_BYTES) }],
    });
    expect(over.status).toBe(413);
  });

  it("a DMCA notice with its longest texts in CJK is read; past its own cap it is 413", async () => {
    const who = await admin();
    const notice = {
      receivedVia: "email",
      complainantName: cjk(500),
      complainantAddress: cjk(2000),
      workDescription: cjk(20_000),
      infringingDescription: cjk(20_000),
      statementGoodFaith: true,
      statementAccuracy: true,
      signature: cjk(500),
      rawText: cjk(200_000),
      nodeIds: [],
    };
    const made = await adminCall(who.as, "POST", "/dmca", { body: notice });
    expect(made.status, made.text.slice(0, 200)).not.toBe(413);
    const over = await adminCall(who.as, "POST", "/dmca", {
      body: { ...notice, rawText: "x".repeat(DMCA_NOTICE_BODY_MAX_BYTES) },
    });
    expect(over.status).toBe(413);
  });

  it("a counter-notice with every text at its longest in CJK is read (about 70 KB)", async () => {
    const who = await admin();
    const counter = {
      counterName: cjk(500),
      counterAddress: cjk(2000),
      counterPhone: cjk(100),
      counterEmail: "counter@example.test",
      counterStatement: cjk(20_000),
      counterConsentJurisdiction: true,
      counterSignature: cjk(500),
    };
    expect(new TextEncoder().encode(JSON.stringify(counter)).byteLength).toBeGreaterThan(JSON_BODY_MAX_BYTES);
    const sent = await adminCall(who.as, "POST", `/dmca/${crypto.randomUUID()}/counter`, { body: counter });
    expect(sent.status, sent.text.slice(0, 200)).not.toBe(413);
  });
});

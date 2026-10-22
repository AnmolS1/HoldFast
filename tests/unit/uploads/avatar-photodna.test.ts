// AVSEAM (b): an avatar goes through the PhotoDNA check the scan consumer runs on images (T21
// step 4) — off in v1, switched on here for the test only, with a made-up key and a mocked Match
// API (global `fetch`). Nothing reaches Microsoft. A match is the CSAM lock (source photodna); a
// failure to CHECK fails closed: the avatar is written `error` and never becomes current.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reports } from "../../../src/worker/db/schema";
import { BLOCKED_MESSAGE } from "../../../src/worker/routes/uploads";
import { totalsOn, utcDay } from "../../../src/worker/db/queries/ledger";
import { PHOTODNA_MATCH_URL, PHOTODNA_MAX_BYTES } from "../../../src/worker/scan/photodna";
import { pngBytes } from "../../setup/fixture-bytes";
import { nodeById, testDb } from "../services-core/helpers";
import {
  complete,
  init,
  putSingle,
  sessionRow,
  sha,
  strikesOf,
  uploader,
  userRow,
  type UserRow,
} from "./helpers";

// A made-up key: the request never leaves the test (fetch is mocked).
const ON = { PHOTODNA_ENABLED: "true", PHOTODNA_SUBSCRIPTION_KEY: "made-up-photodna-test-key" };

let answer: () => Promise<Response>;
let calls: { url: string; init?: RequestInit }[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  answer = async () => Response.json({ Status: { Code: 3000, Description: "OK" }, IsMatch: false });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(PHOTODNA_MATCH_URL)) return realFetch(input, init);
    calls.push({ url, init });
    return answer();
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A picture nobody else has (a match locks its hash; the blocklist is shared). */
const picture = (extra = 0) => {
  const base = pngBytes(32, 32);
  const out = new Uint8Array(base.length + 16 + extra);
  out.set(base);
  crypto.getRandomValues(out.subarray(base.length, base.length + 16));
  return out;
};

async function sendAvatar(user: UserRow, bytes: Uint8Array, extraEnv: Record<string, unknown> = ON) {
  const session = await init(user, {
    purpose: "avatar",
    mimeDeclared: "image/png",
    name: "me.png",
    size: bytes.byteLength,
    fileLastModified: new Date(Date.now() - Math.floor(Math.random() * 1e9)).toISOString(),
  });
  expect((await putSingle(user, session.uploadId, bytes)).status).toBe(200);
  const answered = await complete(user, session.uploadId, { sha256: sha() }, { env: extraEnv });
  return { session, answer: answered };
}

describe("avatar: PhotoDNA", () => {
  it("flag off (the default in every environment): never called", async () => {
    expect(env.PHOTODNA_ENABLED).toBe("false");
    const user = await uploader();
    const { answer: answered } = await sendAvatar(user, picture(), {});
    expect(answered.status).toBe(201);
    expect(calls).toHaveLength(0);
  });

  it("no match: the avatar is set, the check noted; the request carries the key and the image bytes", async () => {
    const user = await uploader();
    const bytes = picture();
    const { answer: answered } = await sendAvatar(user, bytes);
    expect(answered.status).toBe(201);
    expect(answered.body.scanStatus).toBe("clean");
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("Ocp-Apim-Subscription-Key")).toBe(ON.PHOTODNA_SUBSCRIPTION_KEY);
    expect(headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(calls[0]!.init?.body as ArrayBuffer)).toEqual(bytes);
    const node = (await nodeById(String(answered.body.id)))!;
    expect(node.scanDetail).toMatchObject({ photodna: "no_match" });
    expect((await userRow(user.id)).avatarNodeId).toBe(answered.body.id);
  });

  it("a match: the CSAM lock (source photodna) — the object kept, the node locked and held, the user held, never the avatar; the blocked answer", async () => {
    const user = await uploader();
    const good = await sendAvatar(user, picture(), {});
    answer = async () => Response.json({ Status: { Code: 3000, Description: "OK" }, IsMatch: true });
    const { session, answer: answered } = await sendAvatar(user, picture());
    expect(answered.status).toBe(403);
    expect(answered.body).toMatchObject({ error: "forbidden", message: BLOCKED_MESSAGE });
    const row = (await sessionRow(session.uploadId))!;
    expect(await env.FILES.head(row.r2Key)).not.toBeNull();
    expect(await nodeById(row.nodeId)).toMatchObject({
      scanStatus: "suspected_csam",
      legalHold: true,
      ownerId: user.id,
      system: "avatar",
    });
    expect(await userRow(user.id)).toMatchObject({ legalHold: true, avatarNodeId: good.answer.body.id });
    expect(await testDb().select().from(reports).where(eq(reports.ownerId, user.id))).toMatchObject([
      { nodeId: row.nodeId, category: "csam", source: "photodna" },
    ]);
    expect(await strikesOf(user.id)).toHaveLength(0);
  });

  it("fails CLOSED — a network error, every non-200, a non-success status, no key: written `error`, never the avatar, nothing locked", async () => {
    const cases: [string, () => Promise<Response>, Record<string, unknown>][] = [
      [
        "network",
        async () => {
          throw new TypeError("network down");
        },
        ON,
      ],
      ["500", async () => new Response("no", { status: 500 }), ON],
      ["401", async () => new Response("no", { status: 401 }), ON],
      ["429", async () => new Response("no", { status: 429 }), ON],
      ["status", async () => Response.json({ Status: { Code: 3208 }, IsMatch: false }), ON],
      [
        "no key",
        async () => Response.json({ Status: { Code: 3000 }, IsMatch: false }),
        { ...ON, PHOTODNA_SUBSCRIPTION_KEY: "" },
      ],
    ];
    for (const [label, respond, extraEnv] of cases) {
      const user = await uploader();
      const good = await sendAvatar(user, picture(), {});
      answer = respond;
      const { answer: answered } = await sendAvatar(user, picture(), extraEnv);
      expect(answered.status, label).toBe(201);
      expect(answered.body.scanStatus, label).toBe("error");
      const node = (await nodeById(String(answered.body.id)))!;
      expect(node, label).toMatchObject({ scanStatus: "error", scanReason: "engine", legalHold: false });
      expect(node.scanDetail, label).toMatchObject({ photodna: "error" });
      expect((await userRow(user.id)).avatarNodeId, label).toBe(good.answer.body.id);
      expect(await userRow(user.id), label).toMatchObject({ legalHold: false });
    }
  });

  it("an avatar above the Match API's size (4–5 MB) is downscaled through Images first — one transform_user unit for the user", async () => {
    const user = await uploader();
    const inputs: string[] = [];
    const handle = {
      transform: () => handle,
      output: async () => ({ response: () => new Response(picture()) }),
    };
    const fakeImages = {
      input: () => (inputs.push("input"), handle),
      info: async () => ({ width: 32, height: 32 }),
    };
    const before = (await totalsOn(testDb(), utcDay(), "transform_user", user.id)).count;
    const { answer: answered } = await sendAvatar(user, picture(PHOTODNA_MAX_BYTES), {
      ...ON,
      IMAGES: fakeImages,
    });
    expect(answered.status).toBe(201);
    expect(inputs).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]!.init?.headers).get("Content-Type")).toBe("image/jpeg");
    expect((await totalsOn(testDb(), utcDay(), "transform_user", user.id)).count).toBe(before + 1);
    expect((await nodeById(String(answered.body.id)))!.scanDetail).toMatchObject({ photodna: "no_match" });
    expect((await userRow(user.id)).avatarNodeId).toBe(answered.body.id);
  });
});

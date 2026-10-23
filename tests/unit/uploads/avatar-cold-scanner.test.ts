// AVWARM: an avatar uploaded while the scanner is cold. The scanner container sleeps after 10 min and
// clamd answers `not_ready` (clamd_loading / signatures) while it loads; the avatar is scanned in the
// request, so complete WAITS that out (services/scanning.ts `scanSmallObject`) — and only past the
// budget answers `503 scanner_starting` with Retry-After, keeping nothing. Not ready / busy are the
// scanner's normal weather: no Sentry exception; the give-up is one warning-level message.
// The container is T20's mocked `scanSmall` (as in scan/adapter.test.ts); nothing runs Docker.
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodes } from "../../../src/worker/db/schema";
import { ScannerNotReadyError, scanSmall, type ShimVerdict } from "../../../src/worker/scan/container";
import { pngBytes } from "../../setup/fixture-bytes";
import { testDb } from "../services-core/helpers";
import { complete, init, putSingle, sessionRow, sha256Of, uploader, userRow, type UserRow } from "./helpers";

const sentry = vi.hoisted(() => ({
  exceptions: [] as unknown[],
  messages: [] as { message: string; level: unknown }[],
}));

vi.mock("@sentry/cloudflare", async (original) => {
  const real = await original<typeof import("@sentry/cloudflare")>();
  return {
    ...real,
    withScope: (callback: (scope: unknown) => void) =>
      callback({ setTag: () => {}, setContext: () => {}, setLevel: () => {} }),
    captureException: (error: unknown) => void sentry.exceptions.push(error),
    captureMessage: (message: string, level: unknown) => void sentry.messages.push({ message, level }),
  };
});

vi.mock("../../../src/worker/scan/container", async (original) => {
  const real = await original<typeof import("../../../src/worker/scan/container")>();
  return { ...real, scanSmall: vi.fn(real.scanSmall) };
});

beforeEach(() => {
  sentry.exceptions.length = 0;
  sentry.messages.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

/** The real scanner path (the stub off); its container is the mocked `scanSmall`. */
const REAL = { SCAN_STUB: "0" };

/** A picture nobody else has (the blocklist is shared). */
const picture = () => {
  const base = pngBytes(32, 32);
  const out = new Uint8Array(base.length + 16);
  out.set(base);
  crypto.getRandomValues(out.subarray(base.length));
  return out;
};

async function clean(bytes: Uint8Array): Promise<ShimVerdict> {
  return {
    status: "clean",
    signatures: [],
    pua: [],
    sha256: await sha256Of(bytes),
    bytes: bytes.byteLength,
    engine: "ClamAV 1.5.4",
    dbVersion: "28160",
    dbAgeHours: 1,
    durationMs: 4,
  };
}

async function sendAvatar(user: UserRow, bytes: Uint8Array) {
  const session = await init(user, {
    purpose: "avatar",
    mimeDeclared: "image/png",
    name: "me.png",
    size: bytes.byteLength,
  });
  expect((await putSingle(user, session.uploadId, bytes)).status).toBe(200);
  const answer = await complete(user, session.uploadId, {}, { env: REAL, sent: [] });
  return { session, answer };
}

const avatarNodes = (userId: string) =>
  testDb()
    .select()
    .from(nodes)
    .where(and(eq(nodes.ownerId, userId), eq(nodes.system, "avatar")));

describe("avatar on a cold scanner", () => {
  it("not_ready twice (clamd loading), then clean: 201, the avatar is current — and nothing reaches Sentry", async () => {
    const user = await uploader();
    const bytes = picture();
    // Retry-After 0: the waits are the backoff's first steps (1 s, 2 s), not the shim's 30 s.
    vi.mocked(scanSmall)
      .mockRejectedValueOnce(new ScannerNotReadyError("clamd_loading", null, 0))
      .mockRejectedValueOnce(new ScannerNotReadyError("clamd_loading", null, 0))
      .mockResolvedValueOnce(await clean(bytes));
    const { answer } = await sendAvatar(user, bytes);
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ scanStatus: "clean" });
    expect((await userRow(user.id)).avatarNodeId).toBe(String(answer.body.id));
    expect(sentry.exceptions).toEqual([]);
    expect(sentry.messages).toEqual([]);
  });

  it("still not ready when the budget is spent: 503 scanner_starting with Retry-After; nothing kept, the old avatar stays; one warning", async () => {
    const user = await uploader();
    const first = picture();
    vi.mocked(scanSmall).mockResolvedValueOnce(await clean(first));
    const before = await sendAvatar(user, first);
    expect(before.answer.status).toBe(201);
    const current = String(before.answer.body.id);

    // The container took longer than the whole budget to say it is still loading.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.mocked(scanSmall).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 121_000);
      throw new ScannerNotReadyError("clamd_loading", null, 30);
    });
    const { session, answer } = await sendAvatar(user, picture());
    vi.useRealTimers();

    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({
      error: "scanner_starting",
      message: "The virus scanner is starting up. Try again in a minute.",
    });
    expect(answer.headers.get("Retry-After")).toBe("30");
    // Never an unscanned avatar: the session is given up and its object is gone.
    const row = (await sessionRow(session.uploadId))!;
    expect(row.status).toBe("aborted");
    expect(await env.FILES.head(row.r2Key)).toBeNull();
    expect((await avatarNodes(user.id)).map((node) => node.id)).toEqual([current]);
    expect((await userRow(user.id)).avatarNodeId).toBe(current);
    // Expected weather: no exception; the give-up is a warning at most.
    expect(sentry.exceptions).toEqual([]);
    expect(sentry.messages).toEqual([{ message: expect.stringContaining("scanner"), level: "warning" }]);

    // "Try again": a new upload once the scanner is up.
    const again = picture();
    vi.mocked(scanSmall).mockResolvedValueOnce(await clean(again));
    const retried = await sendAvatar(user, again);
    expect(retried.answer.status).toBe(201);
    expect((await userRow(user.id)).avatarNodeId).toBe(String(retried.answer.body.id));
  });

  it("a scanner that fails for real (not starting) still ends `error` and is still reported (the control)", async () => {
    const user = await uploader();
    vi.mocked(scanSmall).mockRejectedValueOnce(new Error("scanner exploded"));
    const { answer } = await sendAvatar(user, picture());
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ scanStatus: "error" });
    expect((await userRow(user.id)).avatarNodeId).not.toBe(String(answer.body.id));
    expect(sentry.exceptions).toHaveLength(1);
  });
});

// Taking trust away is not best-effort. When a password changes, what stood on the old one — a
// browser's known-device proof, a passkey's "counts as a second factor", "remember this device" —
// has to go. Better Auth writes the password with its own statement, outside any transaction of
// ours, so the cleanup cannot be made atomic with it; what it can be is LOUD: if it fails, the
// request fails, and nobody is told "done" while the old trust still stands.
import { like } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as lifecycle from "../../../src/worker/db/queries/auth-lifecycle";
import { verification } from "../../../src/worker/db/schema";
import {
  CAPTCHA,
  linkIn,
  newClient,
  PASSWORD,
  send,
  signIn,
  testDb,
  verifiedUser,
  waitForMail,
} from "./helpers";

vi.mock("../../../src/worker/db/queries/auth-lifecycle", async (original) => {
  const real = await original<typeof import("../../../src/worker/db/queries/auth-lifecycle")>();
  return { ...real, forgetKnownDevices: vi.fn(real.forgetKnownDevices) };
});

const NEW_PASSWORD = "a changed long passphrase 5!";
const proofsOf = async (userId: string) =>
  (await testDb().select().from(verification).where(like(verification.identifier, "known-device:%"))).filter(
    (row) => row.value === userId,
  );

describe("a cleanup that revokes trust fails the request when it cannot be done", () => {
  /** A known-device proof of the account, as a passed second factor leaves one. */
  async function withProof(userId: string) {
    await lifecycle.putKnownDevice(testDb(), {
      id: crypto.randomUUID().replace(/-/g, ""),
      deviceId: crypto.randomUUID().replace(/-/g, ""),
      userId,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect((await proofsOf(userId)).length).toBe(1);
  }

  it("change-password: the answer is an error, not 'changed' — and the next change, once the cleanup works, leaves no proof", async () => {
    const owner = await verifiedUser();
    await withProof(owner.user.id);
    vi.mocked(lifecycle.forgetKnownDevices).mockRejectedValueOnce(new Error("connection terminated"));
    const failed = await send(owner.client, "/api/auth/change-password", {
      json: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(failed.status, failed.text).toBe(500);
    // (Better Auth had already written the password — which is why the failure must be heard.)
    expect((await proofsOf(owner.user.id)).length).toBe(1);
    const again = newClient();
    expect((await signIn(again, owner.email, NEW_PASSWORD)).status).toBe(200);
    const changed = await send(again, "/api/auth/change-password", {
      json: { currentPassword: NEW_PASSWORD, newPassword: "and another long passphrase 6!" },
    });
    expect(changed.status, changed.text).toBe(200);
    expect(await proofsOf(owner.user.id)).toEqual([]);
  });

  it("reset-password: the same — an error, never a silent success", async () => {
    const owner = await verifiedUser();
    await withProof(owner.user.id);
    await send(newClient(), "/api/auth/request-password-reset", {
      json: { email: owner.email, redirectTo: "/reset-password" },
      headers: CAPTCHA,
    });
    const follow = await send(newClient(), linkIn(await waitForMail(owner.email, "passwordReset")));
    const token = new URL(follow.headers.get("location")!, "http://localhost").searchParams.get("token")!;
    vi.mocked(lifecycle.forgetKnownDevices).mockRejectedValueOnce(new Error("connection terminated"));
    const failed = await send(newClient(), "/api/auth/reset-password", {
      headers: CAPTCHA,
      json: { newPassword: NEW_PASSWORD, token },
    });
    expect(failed.status, failed.text).toBe(500);
  });
});

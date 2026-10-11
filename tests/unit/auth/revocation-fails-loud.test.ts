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
  auditRows,
  CAPTCHA,
  getSession,
  linkIn,
  newClient,
  PASSWORD,
  promoteToAdmin,
  send,
  sessionsOf,
  signIn,
  testDb,
  userById,
  verifiedUser,
  waitForMail,
} from "./helpers";

vi.mock("../../../src/worker/db/queries/auth-lifecycle", async (original) => {
  const real = await original<typeof import("../../../src/worker/db/queries/auth-lifecycle")>();
  return {
    ...real,
    forgetKnownDevices: vi.fn(real.forgetKnownDevices),
    forgetPasskeyMarks: vi.fn(real.forgetPasskeyMarks),
  };
});

const NEW_PASSWORD = "a changed long passphrase 5!";
const proofsOf = async (userId: string) =>
  (await testDb().select().from(verification).where(like(verification.identifier, "known-device:%"))).filter(
    (row) => row.value === userId,
  );

const failing = (times: number) => {
  const mock = vi.mocked(lifecycle.forgetKnownDevices);
  mock.mockClear();
  for (let n = 0; n < times; n++) mock.mockRejectedValueOnce(new Error("connection terminated"));
  return mock;
};
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
async function resetToken(email: string) {
  await send(newClient(), "/api/auth/request-password-reset", {
    json: { email, redirectTo: "/reset-password" },
    headers: CAPTCHA,
  });
  const follow = await send(newClient(), linkIn(await waitForMail(email, "passwordReset")));
  return new URL(follow.headers.get("location")!, "http://localhost").searchParams.get("token")!;
}

// What must hold WHATEVER the cleanup does (N2, N3, N9): the sessions are gone first, the owner
// is told and the change is in the audit log; the cleanup is tried twice; and only if it still
// fails is the answer a 5xx — said after all of that, not instead of it.
describe("a password reset whose cleanup fails", () => {
  it("once: the retry does it — 200, nothing left standing", async () => {
    const owner = await verifiedUser();
    await withProof(owner.user.id);
    const token = await resetToken(owner.email);
    const mock = failing(1);
    const done = await send(newClient(), "/api/auth/reset-password", {
      headers: CAPTCHA,
      json: { newPassword: NEW_PASSWORD, token },
    });
    expect(done.status, done.text).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(await proofsOf(owner.user.id)).toEqual([]);
    expect(await sessionsOf(owner.user.id)).toEqual([]);
  });

  it("twice: 5xx — and still every session is ended, the owner is mailed and the change is audited", async () => {
    const owner = await verifiedUser();
    await withProof(owner.user.id);
    expect((await sessionsOf(owner.user.id)).length).toBe(1);
    const token = await resetToken(owner.email);
    failing(2);
    const failed = await send(newClient(), "/api/auth/reset-password", {
      headers: CAPTCHA,
      json: { newPassword: NEW_PASSWORD, token },
    });
    expect(failed.status, failed.text).toBe(500);
    // The thing a reset after a compromise is FOR.
    expect(await sessionsOf(owner.user.id)).toEqual([]);
    expect((await send(owner.client, "/api/auth/get-session")).body).toBeNull();
    await waitForMail(owner.email, "passwordChanged");
    const audited = (await auditRows({ action: "auth.password_changed", targetId: owner.user.id })).filter(
      (row) => (row.meta as { via?: string } | null)?.via === "reset",
    );
    expect(audited).toHaveLength(1);
    // (The proof the failed statement was to remove still stands — which is what the 5xx says.)
    expect((await proofsOf(owner.user.id)).length).toBe(1);
  });
});

describe("a password change whose cleanup fails", () => {
  const change = (client: Parameters<typeof send>[0], from: string, to: string) =>
    send(client, "/api/auth/change-password", { json: { currentPassword: from, newPassword: to } });

  it("once: the retry does it — 200", async () => {
    const owner = await verifiedUser();
    await withProof(owner.user.id);
    const mock = failing(1);
    const done = await change(owner.client, PASSWORD, NEW_PASSWORD);
    expect(done.status, done.text).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(await proofsOf(owner.user.id)).toEqual([]);
  });

  it("twice: 5xx — but the caller keeps the new session, the other sessions are ended, the owner is mailed and the change is audited", async () => {
    const owner = await verifiedUser();
    await withProof(owner.user.id);
    const elsewhere = newClient();
    expect((await signIn(elsewhere, owner.email)).status).toBe(200);
    failing(2);
    const failed = await change(owner.client, PASSWORD, NEW_PASSWORD);
    expect(failed.status, failed.text).toBe(500);
    // The answer still carries the session Better Auth made for the caller…
    expect(failed.setCookies.join("\n")).toContain("hf.session_token=");
    expect((await getSession(owner.client))?.user.id).toBe(owner.user.id);
    // …the other session is gone…
    expect(await getSession(elsewhere)).toBeNull();
    expect(await sessionsOf(owner.user.id)).toHaveLength(1);
    // …and the change is on record and the owner told.
    await waitForMail(owner.email, "passwordChanged");
    const audited = (await auditRows({ action: "auth.password_changed", targetId: owner.user.id })).filter(
      (row) => (row.meta as { via?: string } | null)?.via === "change",
    );
    expect(audited).toHaveLength(1);
    expect((await proofsOf(owner.user.id)).length).toBe(1);
    // The next change, with the cleanup working, leaves no proof.
    expect((await change(owner.client, NEW_PASSWORD, "and another long passphrase 6!")).status).toBe(200);
    expect(await proofsOf(owner.user.id)).toEqual([]);
  });
});

describe("a role change whose cleanup fails", () => {
  it("twice: 5xx — and the target's sessions are ended all the same (the role HAS changed)", async () => {
    const boss = await verifiedUser();
    await promoteToAdmin(boss.user.id);
    const target = await verifiedUser();
    expect(await sessionsOf(target.user.id)).toHaveLength(1);
    const marks = vi.mocked(lifecycle.forgetPasskeyMarks);
    marks.mockClear();
    marks.mockRejectedValueOnce(new Error("connection terminated"));
    marks.mockRejectedValueOnce(new Error("connection terminated"));
    const failed = await send(boss.client, "/api/auth/admin/set-role", {
      json: { userId: target.user.id, role: "admin" },
    });
    expect(failed.status, failed.text).toBe(500);
    expect(marks).toHaveBeenCalledTimes(2);
    expect((await userById(target.user.id))!.role).toBe("admin");
    expect(await sessionsOf(target.user.id)).toEqual([]);
    // Once: the retry does it.
    const other = await verifiedUser();
    marks.mockRejectedValueOnce(new Error("connection terminated"));
    const done = await send(boss.client, "/api/auth/admin/set-role", {
      json: { userId: other.user.id, role: "user" },
    });
    expect(done.status, done.text).toBe(200);
    expect(await sessionsOf(other.user.id)).toEqual([]);
  });
});

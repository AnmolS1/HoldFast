// Taking trust away is not best-effort. When a password changes, what stood on the old one — a
// browser's known-device proof, a passkey's "counts as a second factor", "remember this device" —
// has to go. Better Auth writes the password with its own statement, outside any transaction of
// ours, so the cleanup cannot be made atomic with it; what it can be is LOUD: if it fails, the
// request fails, and nobody is told "done" while the old trust still stands.
import { eq, like } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as lifecycle from "../../../src/worker/db/queries/auth-lifecycle";
import { session, user, verification } from "../../../src/worker/db/schema";
import { suspendUser, SYSTEM_ACTOR, unsuspendUser } from "../../../src/worker/services/account-state";
import {
  auditRows,
  CAPTCHA,
  enableTotp,
  eventually,
  getSession,
  linkIn,
  newClient,
  nextTotp,
  PASSWORD,
  promoteToAdmin,
  send,
  serviceDeps,
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

// P2 — the two-factor change paths have the same shape: Better Auth has already switched the
// factor off (or confirmed the enrolment) and set the new session's cookie when the cleanup runs.
describe("a two-factor change whose cleanup fails", () => {
  it("disable, twice: 5xx — with the new session cookie kept, the change audited and the owner mailed; once: 200", async () => {
    const owner = await verifiedUser();
    await enableTotp(owner.client);
    failing(2);
    const failed = await send(owner.client, "/api/auth/two-factor/disable", { json: { password: PASSWORD } });
    expect(failed.status, failed.text).toBe(500);
    expect(failed.setCookies.join("\n")).toContain("hf.session_token=");
    expect((await getSession(owner.client))?.user.id).toBe(owner.user.id);
    expect((await userById(owner.user.id))!.twoFactorEnabled).toBe(false);
    await waitForMail(owner.email, "twoFactorDisabled");
    expect(await auditRows({ action: "auth.2fa_disabled", targetId: owner.user.id })).toHaveLength(1);

    const other = await verifiedUser();
    await enableTotp(other.client);
    const mock = failing(1);
    const done = await send(other.client, "/api/auth/two-factor/disable", { json: { password: PASSWORD } });
    expect(done.status, done.text).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("the confirming code of an enrolment, twice: 5xx — and two-factor IS on, audited, the owner mailed, the session kept", async () => {
    const owner = await verifiedUser();
    const enabled = await send(owner.client, "/api/auth/two-factor/enable", { json: { password: PASSWORD } });
    const { totpURI } = enabled.body as { totpURI: string };
    failing(2);
    const failed = await send(owner.client, "/api/auth/two-factor/verify-totp", {
      json: { code: await nextTotp(totpURI) },
    });
    expect(failed.status, failed.text).toBe(500);
    expect((await userById(owner.user.id))!.twoFactorEnabled).toBe(true);
    expect((await getSession(owner.client))?.user.id).toBe(owner.user.id);
    await waitForMail(owner.email, "twoFactorEnabled");
    expect(await auditRows({ action: "auth.2fa_enabled", targetId: owner.user.id })).toHaveLength(1);
  });
});

describe("what an account's browsers and keys have standing: capped, and gone with a ban or a suspension", () => {
  const marks = async (userId: string) =>
    (await testDb().select().from(verification).where(like(verification.identifier, "passkey-2f:%"))).filter(
      (row) => row.value === userId,
    );
  const device = (userId: string) => ({
    id: crypto.randomUUID().replace(/-/g, ""),
    deviceId: crypto.randomUUID().replace(/-/g, ""),
    userId,
    expiresAt: new Date(Date.now() + 3_600_000),
  });

  it(`an account keeps at most ${lifecycle.KNOWN_DEVICE_MAX} known-device proofs — the oldest go, also when many are made at once`, async () => {
    const owner = await verifiedUser();
    const first = device(owner.user.id);
    await lifecycle.putKnownDevice(testDb(), first);
    for (let n = 0; n < lifecycle.KNOWN_DEVICE_MAX + 4; n++) {
      await lifecycle.putKnownDevice(testDb(), device(owner.user.id));
    }
    const kept = await proofsOf(owner.user.id);
    expect(kept).toHaveLength(lifecycle.KNOWN_DEVICE_MAX);
    expect(kept.map((row) => row.identifier)).not.toContain(`known-device:${first.deviceId}`);
    await Promise.all(
      Array.from({ length: 30 }, () => lifecycle.putKnownDevice(testDb(), device(owner.user.id))),
    );
    expect(await proofsOf(owner.user.id)).toHaveLength(lifecycle.KNOWN_DEVICE_MAX);
    // Another account's are not touched.
    const other = await verifiedUser();
    await lifecycle.putKnownDevice(testDb(), device(other.user.id));
    expect(await proofsOf(other.user.id)).toHaveLength(1);
  });

  it.each(["ban", "suspension"] as const)(
    "a %s deletes the account's device proofs and key marks with its sessions",
    async (how) => {
      const boss = await verifiedUser();
      await promoteToAdmin(boss.user.id);
      const target = await verifiedUser();
      await lifecycle.putKnownDevice(testDb(), device(target.user.id));
      await lifecycle.putAuthMarker(testDb(), {
        id: crypto.randomUUID().replace(/-/g, ""),
        identifier: `passkey-2f:${crypto.randomUUID()}`,
        userId: target.user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      expect([(await proofsOf(target.user.id)).length, (await marks(target.user.id)).length]).toEqual([1, 1]);
      if (how === "ban") {
        const banned = await send(boss.client, "/api/auth/admin/ban-user", {
          json: { userId: target.user.id },
        });
        expect(banned.status, banned.text).toBe(200);
      } else {
        const { deps, settle } = serviceDeps();
        expect(await suspendUser(deps, target.user.id, "test", SYSTEM_ACTOR)).toBe(true);
        await settle();
      }
      expect(await sessionsOf(target.user.id)).toEqual([]);
      expect(await proofsOf(target.user.id)).toEqual([]);
      expect(await marks(target.user.id)).toEqual([]);
    },
  );
});

// B2 / B3 — one function ends an account's sessions, device proofs and key marks for EVERY way it
// is locked or unlocked, under the user's row lock; and nothing minted by a success that races
// the lock outlives it.
describe("locking an account and what races it", () => {
  const device = (userId: string) => ({
    id: crypto.randomUUID().replace(/-/g, ""),
    deviceId: crypto.randomUUID().replace(/-/g, ""),
    userId,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const marks = async (userId: string) =>
    (await testDb().select().from(verification).where(like(verification.identifier, "passkey-2f:%"))).filter(
      (row) => row.value === userId,
    );
  const plantMark = (userId: string) =>
    lifecycle.putAuthMarker(testDb(), {
      id: crypto.randomUUID().replace(/-/g, ""),
      identifier: `passkey-2f:${crypto.randomUUID()}`,
      userId,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

  it("a suspension and forty known-device proofs being made at the same moment: none survives it — and a locked account is given none afterwards", async () => {
    for (let round = 0; round < 3; round++) {
      const target = await verifiedUser();
      const { deps, settle } = serviceDeps();
      const [suspended] = await Promise.all([
        suspendUser(deps, target.user.id, "test", SYSTEM_ACTOR),
        ...Array.from({ length: 40 }, () => lifecycle.putKnownDevice(testDb(), device(target.user.id))),
      ]);
      await settle();
      expect(suspended).toBe(true);
      expect(await proofsOf(target.user.id), `round ${round}`).toEqual([]);
      await lifecycle.putKnownDevice(testDb(), device(target.user.id));
      expect(await proofsOf(target.user.id)).toEqual([]);
    }
  });

  it("what was minted WHILE the account was locked does not come back with the unlock: a session, a proof and a key mark planted during a suspension are gone when it is lifted", async () => {
    const target = await verifiedUser();
    const { deps, settle } = serviceDeps();
    expect(await suspendUser(deps, target.user.id, "test", SYSTEM_ACTOR)).toBe(true);
    // As a sign-in / a passed factor that was already past its check when the lock landed would
    // have left them (written straight to the tables: no request can do it while suspended).
    const at = new Date();
    await testDb()
      .insert(session)
      .values({
        id: crypto.randomUUID().replace(/-/g, ""),
        token: `raced-${crypto.randomUUID()}`,
        userId: target.user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        createdAt: at,
        updatedAt: at,
      });
    await testDb()
      .insert(verification)
      .values({
        id: crypto.randomUUID().replace(/-/g, ""),
        identifier: `known-device:${crypto.randomUUID().replace(/-/g, "")}`,
        value: target.user.id,
        expiresAt: new Date(Date.now() + 3_600_000),
        createdAt: at,
        updatedAt: at,
      });
    await plantMark(target.user.id);
    expect(await unsuspendUser(deps, target.user.id, SYSTEM_ACTOR)).toBe(true);
    await settle();
    expect(await sessionsOf(target.user.id)).toEqual([]);
    expect(await proofsOf(target.user.id)).toEqual([]);
    expect(await marks(target.user.id)).toEqual([]);
  });

  it("an unban, and a deletion date that has passed, use the same function", async () => {
    const boss = await verifiedUser();
    await promoteToAdmin(boss.user.id);
    const banned = await verifiedUser();
    expect(
      (await send(boss.client, "/api/auth/admin/ban-user", { json: { userId: banned.user.id } })).status,
    ).toBe(200);
    await plantMark(banned.user.id);
    expect(
      (await send(boss.client, "/api/auth/admin/unban-user", { json: { userId: banned.user.id } })).status,
    ).toBe(200);
    expect(await marks(banned.user.id)).toEqual([]);

    const leaving = await verifiedUser();
    await lifecycle.putKnownDevice(testDb(), device(leaving.user.id));
    await plantMark(leaving.user.id);
    await testDb()
      .update(user)
      .set({ deleteScheduledAt: new Date(Date.now() - 60_000) })
      .where(eq(user.id, leaving.user.id));
    await send(leaving.client, "/api/auth/get-session");
    await eventually(async () => (await sessionsOf(leaving.user.id)).length === 0);
    expect(await proofsOf(leaving.user.id)).toEqual([]);
    expect(await marks(leaving.user.id)).toEqual([]);
  });
});

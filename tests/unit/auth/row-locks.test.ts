// T6 — the row locks, deterministically.
//
// Four functions take a row lock (`SELECT … FOR UPDATE`) before they act, so that whatever races
// with them has either finished or waits: the two clean-ups of an unproven account and the sweep
// after a provider link (the `user` row), and the acceptance of a TOTP step (the `two_factor`
// row). The race tests around them (google-linking, mailbox-proof, second-factor) rely on
// `Promise.all` interleaving; a missing lock could pass them by luck.
//
// Here another transaction HOLDS a lock on the row — `FOR KEY SHARE`, the weakest row lock: it
// conflicts with `FOR UPDATE` and with nothing the functions do afterwards (their deletes are of
// other tables' rows, their updates of non-key columns take `FOR NO KEY UPDATE`). So the function
// blocks exactly when it asks for its own lock, and cannot when that request is removed.
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  acceptTotpStep,
  clearForMailboxProof,
  clearUnprovenAccount,
  sweepAfterLink,
} from "../../../src/worker/db/queries/auth-lifecycle";
import { twoFactor, user } from "../../../src/worker/db/schema";
import { enableTotp, newClient, signUp, testDb, userByEmail, verifiedUser } from "./helpers";

const HELD_MS = 500;

/**
 * Runs `work` while another transaction holds `FOR KEY SHARE` on one row. Resolves to whether
 * `work` was still waiting after HELD_MS — and to its result once the holder has committed.
 */
async function whileHeld<T>(
  lock: (tx: Parameters<Parameters<ReturnType<typeof testDb>["transaction"]>[0]>[0]) => Promise<unknown>,
  work: () => Promise<T>,
) {
  let waiting = false;
  let pending!: Promise<T>;
  await testDb().transaction(async (tx) => {
    await lock(tx);
    let settled = false;
    pending = work().finally(() => (settled = true));
    // (not to be reported as unhandled while the holder sleeps)
    pending.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, HELD_MS));
    waiting = !settled;
  });
  return { waiting, result: await pending };
}

const holdUser = (id: string) => (tx: { execute(query: ReturnType<typeof sql>): Promise<unknown> }) =>
  tx.execute(sql`SELECT id FROM "user" WHERE id = ${id} FOR KEY SHARE`);

async function unverified() {
  const { email } = await signUp(newClient());
  return (await userByEmail(email))!;
}
const RESET = {
  termsAcceptedAt: new Date(),
  termsVersion: "2026-10-01",
  ageVerifiedAt: new Date(),
  invitedBy: null,
  quotaBytes: 1,
  name: "",
};

describe("each function waits for the row it locks — and (the control) for no other row", () => {
  it("clearUnprovenAccount locks the user row", async () => {
    const row = await unverified();
    const held = await whileHeld(holdUser(row.id), () => clearUnprovenAccount(testDb(), row.id, RESET));
    expect(held.waiting).toBe(true);
    expect(held.result).not.toBeNull();
    // The control: with ANOTHER user's row held, it does not wait.
    const other = await unverified();
    const bystander = await unverified();
    const free = await whileHeld(holdUser(bystander.id), () =>
      clearUnprovenAccount(testDb(), other.id, RESET),
    );
    expect(free.waiting).toBe(false);
  });

  it("clearForMailboxProof locks the user row", async () => {
    const row = await unverified();
    const held = await whileHeld(holdUser(row.id), () => clearForMailboxProof(testDb(), row.id, row.email));
    expect(held.waiting).toBe(true);
    expect(held.result).not.toBeNull();
    expect((await testDb().select().from(user).where(eq(user.id, row.id)))[0]!.emailVerified).toBe(true);
    const other = await unverified();
    const bystander = await unverified();
    const free = await whileHeld(holdUser(bystander.id), () =>
      clearForMailboxProof(testDb(), other.id, other.email),
    );
    expect(free.waiting).toBe(false);
  });

  it("sweepAfterLink locks the user row", async () => {
    const row = await unverified();
    const held = await whileHeld(holdUser(row.id), () => sweepAfterLink(testDb(), row.id));
    expect(held.waiting).toBe(true);
    const other = await unverified();
    const bystander = await unverified();
    const free = await whileHeld(holdUser(bystander.id), () => sweepAfterLink(testDb(), other.id));
    expect(free.waiting).toBe(false);
  });

  it("acceptTotpStep locks the account's two-factor row", async () => {
    const made = await verifiedUser();
    await enableTotp(made.client);
    const holdFactor =
      (userId: string) => (tx: { execute(query: ReturnType<typeof sql>): Promise<unknown> }) =>
        tx.execute(sql`SELECT id FROM two_factor WHERE user_id = ${userId} FOR KEY SHARE`);
    const step = Math.floor(Date.now() / 30_000) + 1_000;
    const held = await whileHeld(holdFactor(made.user.id), () =>
      acceptTotpStep(testDb(), made.user.id, { id: crypto.randomUUID(), step }),
    );
    expect(held.waiting).toBe(true);
    expect(held.result).toBe(true);
    // … and under that lock a step is accepted once: the same step again is a replay.
    expect(await acceptTotpStep(testDb(), made.user.id, { id: crypto.randomUUID(), step })).toBe(false);
    const other = await verifiedUser();
    await enableTotp(other.client);
    const free = await whileHeld(holdFactor(made.user.id), () =>
      acceptTotpStep(testDb(), other.user.id, { id: crypto.randomUUID(), step }),
    );
    expect(free.waiting).toBe(false);
    expect((await testDb().select().from(twoFactor).where(eq(twoFactor.userId, other.user.id))).length).toBe(
      1,
    );
  });
});

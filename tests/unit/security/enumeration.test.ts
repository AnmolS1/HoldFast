// Account enumeration (T26 item 13): sign-up with an address that has an account, a password
// reset for an address that has none, and a share to an address that has none (a pending-by-email
// share) answer exactly like their counterparts — and the CODE PATH does the same work in both
// branches: the password hasher is called the same number of times (a spy, not a stopwatch), and
// the same number of SQL statements is sent before the answer exists.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as passwordWork from "../../../src/worker/auth/password";
import { CAPTCHA, freshEmail, measured, newClient, signUp, verifiedUser } from "../auth/helpers";
import { api, asCaller, makeFolder, member, settingsWith } from "../sharing/helpers";

vi.mock("../../../src/worker/auth/password", async (original) => {
  const real = await original<typeof import("../../../src/worker/auth/password")>();
  return { ...real, hashPassword: vi.fn(real.hashPassword), verifyPassword: vi.fn(real.verifyPassword) };
});

const hashes = () => vi.mocked(passwordWork.hashPassword).mock.calls.length;
const verifies = () => vi.mocked(passwordWork.verifyPassword).mock.calls.length;

beforeEach(() => {
  vi.mocked(passwordWork.hashPassword).mockClear();
  vi.mocked(passwordWork.verifyPassword).mockClear();
});

/** What a caller can compare: the status and the body's keys, recursively. */
function outline(status: number, body: unknown): unknown {
  const shape = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(shape)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, shape(item)]),
          )
        : value === null
          ? "null"
          : typeof value;
  return { status, body: shape(body) };
}

describe("sign-up with an address that has an account", () => {
  it("answers like a new address, and both branches call the hasher exactly once", async () => {
    const existing = await verifiedUser();
    const before = hashes();
    const fresh = await signUp(newClient(), { name: "Same Name" });
    const freshHashes = hashes() - before;
    const again = await signUp(newClient(), { email: existing.email, name: "Same Name" });
    const againHashes = hashes() - before - freshHashes;
    expect(outline(again.sent.status, again.sent.body)).toEqual(outline(fresh.sent.status, fresh.sent.body));
    expect(fresh.sent.status).toBe(200);
    expect(freshHashes).toBe(1);
    expect(againHashes).toBe(1);
  });
});

describe("a password reset for an address that has no account", () => {
  it("answers like one for an existing address, with the same hashing and the same statements before the answer", async () => {
    const existing = await verifiedUser();
    const ask = (email: string) =>
      measured(newClient(), "/api/auth/request-password-reset", {
        json: { email, redirectTo: "/reset-password" },
        headers: CAPTCHA,
      });
    // Warm both paths once (first-use module and statement caches), then measure.
    await ask(existing.email);
    await ask(freshEmail());
    const work = () => hashes() + verifies();

    const w0 = work();
    const known = await ask(existing.email);
    const knownWork = work() - w0;
    const w1 = work();
    const unknown = await ask(freshEmail());
    const unknownWork = work() - w1;

    expect(known.sent.status).toBe(200);
    expect(unknown.sent.body).toEqual(known.sent.body);
    expect(outline(unknown.sent.status, unknown.sent.body)).toEqual(
      outline(known.sent.status, known.sent.body),
    );
    expect(unknownWork).toBe(knownWork);
    expect(unknown.statements).toBe(known.statements);
  });
});

describe("a share to an address that has no account (pending by e-mail, D5)", () => {
  it("answers like a share to an existing account, with the same statements before the answer", async () => {
    const owner = await member();
    const known = await member();
    const a = await makeFolder(owner.id);
    const b = await makeFolder(owner.id);
    const share = (nodeId: string, email: string) =>
      api(asCaller(owner), `/nodes/${nodeId}/shares`, {
        json: { email, role: "viewer" },
        settings: settingsWith(),
      });
    const before = hashes() + verifies();
    const toKnown = await share(a.id, known.email);
    const toUnknown = await share(b.id, freshEmail());
    expect([toKnown.status, toUnknown.status]).toEqual([201, 201]);
    expect(outline(toUnknown.status, toUnknown.body)).toEqual(outline(toKnown.status, toKnown.body));
    expect(toUnknown.statements).toBe(toKnown.statements);
    // No password work on either branch.
    expect(hashes() + verifies()).toBe(before);
  });
});

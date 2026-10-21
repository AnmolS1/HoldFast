// `POST …/unlock` and the password throttle (D7) as wired here: the lock is asked BEFORE the hash,
// a wrong password records a failure, a right one clears it, and the link itself is never paused.
// The schedule itself (2^(n-3) s, at most 900 s) is T05's and T22's suite. Every password is made up.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_FREE_ATTEMPTS } from "../../../src/worker/db/queries/links";
import { scryptInternals } from "../../../src/worker/services/link-password";
import { api, asCaller, errorOf, linkById, makeFile, member } from "./helpers";
import { linkTo, mint, unlock, visit } from "./public-helpers";

const PASSWORD = "made-up visitor password";
const IP = "198.51.100.77";
const OTHER_IP = "198.51.100.78";

afterEach(() => vi.restoreAllMocks());

async function passwordLink() {
  const owner = await member();
  const file = await makeFile(owner.id, null, { scanStatus: "clean" });
  return { owner, link: await linkTo(owner, file.id, { password: PASSWORD }) };
}

describe("POST /public/links/:token/unlock", () => {
  it("the right password: a session bound to this address; it opens the link from here and not from elsewhere", async () => {
    const { link } = await passwordLink();
    const { answer, session } = await unlock(link.token, PASSWORD, { ip: IP });
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body as object).sort()).toEqual(["expiresAt", "linkSession"]);
    const expiresIn = new Date((answer.body as { expiresAt: string }).expiresAt).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(3_500_000);
    expect(expiresIn).toBeLessThanOrEqual(3_600_000);
    expect((await mint(link.token, { kind: "download" }, { session, ip: IP })).status).toBe(200);
    const elsewhere = await mint(link.token, { kind: "download" }, { session, ip: OTHER_IP });
    expect([elsewhere.status, errorOf(elsewhere).error]).toEqual([403, "password_required"]);
    expect(answer.headers["set-cookie"]).toBeUndefined();
  });

  it("wrong: 403 password_required with wrongPassword; three carry no delay, the fourth locks; a locked call is 429 and costs no hash", async () => {
    const { link } = await passwordLink();
    const derive = vi.spyOn(scryptInternals, "derive");
    for (let i = 1; i <= 3; i++) {
      const { answer } = await unlock(link.token, `wrong ${i}`, { ip: IP });
      expect([answer.status, errorOf(answer).error, errorOf(answer).details]).toEqual([
        403,
        "password_required",
        { wrongPassword: true, retryAfterSec: 0 },
      ]);
    }
    const fourth = (await unlock(link.token, "wrong 4", { ip: IP })).answer;
    expect(errorOf(fourth).details?.wrongPassword).toBe(true);
    expect(Number(errorOf(fourth).details?.retryAfterSec)).toBeGreaterThanOrEqual(1);
    expect(derive).toHaveBeenCalledTimes(4);

    // Locked: even the right password is not evaluated.
    const locked = (await unlock(link.token, PASSWORD, { ip: IP })).answer;
    expect([locked.status, errorOf(locked).error]).toEqual([429, "rate_limited"]);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(derive).toHaveBeenCalledTimes(4);

    // Per address: another one is not locked. The link itself is never paused.
    expect((await unlock(link.token, PASSWORD, { ip: OTHER_IP })).answer.status).toBe(200);
    const row = await linkById(link.id);
    expect([row.pauseReasons, row.pausedAt]).toEqual([[], null]);
  });

  it("a parallel burst of wrong guesses from one address: at most free attempts + 1 hash checks, the rest 429 without a hash", async () => {
    const { link } = await passwordLink();
    const derive = vi.spyOn(scryptInternals, "derive");
    const K = 10;
    const answers = await Promise.all(
      Array.from({ length: K }, (_, i) =>
        unlock(link.token, `made-up wrong ${i}`, { ip: IP }).then((r) => r.answer),
      ),
    );
    const evaluated = answers.filter((answer) => answer.status === 403);
    const locked = answers.filter((answer) => answer.status === 429);
    expect(evaluated.length + locked.length).toBe(K);
    expect(evaluated.length).toBeLessThanOrEqual(PASSWORD_FREE_ATTEMPTS + 1);
    expect(derive.mock.calls.length).toBe(evaluated.length);
    for (const answer of evaluated) expect(errorOf(answer).details?.wrongPassword).toBe(true);
    for (const answer of locked) expect(errorOf(answer).error).toBe("rate_limited");
  });

  it("a moved request clock does not move the advertised wait: retryAfterSec comes from the database's clock", async () => {
    const { link } = await passwordLink();
    const skewed = { "x-holdfast-test-now": new Date(Date.now() + 3_600_000).toISOString() };
    for (let i = 1; i <= 3; i++) await unlock(link.token, `made-up wrong ${i}`, { ip: IP, headers: skewed });
    const fourth = (await unlock(link.token, "made-up wrong 4", { ip: IP, headers: skewed })).answer;
    // Failure 4 locks for 2^(4-3) = 2 s.
    expect(Number(errorOf(fourth).details?.retryAfterSec)).toBeGreaterThanOrEqual(1);
    expect(Number(errorOf(fourth).details?.retryAfterSec)).toBeLessThanOrEqual(2);
  });

  it("the right password clears the failures of that address", async () => {
    const { link } = await passwordLink();
    await unlock(link.token, "wrong 1", { ip: IP });
    await unlock(link.token, "wrong 2", { ip: IP });
    expect((await unlock(link.token, PASSWORD, { ip: IP })).answer.status).toBe(200);
    // Three more failures carry no delay again: the count started over.
    for (let i = 0; i < 3; i++) {
      const { answer } = await unlock(link.token, `wrong again ${i}`, { ip: IP });
      expect(errorOf(answer).details?.retryAfterSec).toBe(0);
    }
  });

  it("rows 1–8 come first: a paused link is 423 before any password is looked at", async () => {
    const { owner, link } = await passwordLink();
    const derive = vi.spyOn(scryptInternals, "derive");
    await api(asCaller(owner), `/links/${link.id}`, { method: "PATCH", json: { paused: true } });
    const answer = (await unlock(link.token, PASSWORD)).answer;
    expect([answer.status, errorOf(answer).details?.reason]).toEqual([423, "unavailable"]);
    expect(derive).not.toHaveBeenCalled();
    expect((await visit("AAAAAAAAAAAAAAAAAAAAAA", "/unlock", { json: { password: PASSWORD } })).status).toBe(
      404,
    );
  });

  it("an empty body or an empty password is 400", async () => {
    const { link } = await passwordLink();
    expect((await visit(link.token, "/unlock", { json: {} })).status).toBe(400);
    expect((await visit(link.token, "/unlock", { json: { password: "" } })).status).toBe(400);
  });
});

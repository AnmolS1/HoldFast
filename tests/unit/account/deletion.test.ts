// The deletion as the account page relies on it — T06's request (Better Auth's delete-user and its
// mailed link), status and cancel routes — asserted on the rows: signing in cancels nothing, Cancel
// gives back exactly the `owner_deletion` pause on every link of the account wherever it sits, and
// a held account is told nothing different.
import { describe, expect, it } from "vitest";
import {
  linkById,
  linkIn,
  makeLink,
  mailTo,
  newClient,
  send,
  signIn,
  testDb,
  userById,
  verifiedUser,
  waitForMail,
  type Client,
} from "../auth/helpers";
import { makeFile, makeFolder } from "../services-core/helpers";
import { user } from "../../../src/worker/db/schema";
import { eq } from "drizzle-orm";

async function scheduleDeletion(client: Client, email: string) {
  const before = mailTo(email, "deleteAccountVerification").length;
  const asked = await send(client, "/api/auth/delete-user", { json: {} });
  expect(asked.status).toBe(200);
  const mail = await waitForMail(email, "deleteAccountVerification", before + 1);
  const followed = await send(client, linkIn(mail));
  expect(followed.status).toBe(302);
  expect(followed.headers.get("location")).toBe("http://localhost/account?deletion=scheduled");
}

const status = async (client: Client) =>
  (await send(client, "/api/account/deletion-status")).body as { scheduledFor: string | null };

describe("deletion, as the account page sees it", () => {
  it("deletion-status shows the date; signing in again cancels nothing; Cancel restores exactly the owner_deletion pause", async () => {
    const { client, email, user: row } = await verifiedUser();
    // A file two folders deep with a link already paused for a report, and a plain link at the top.
    const outer = await makeFolder(row.id);
    const inner = await makeFolder(row.id, outer.id);
    const deep = await makeFile(row.id, inner.id, { scanStatus: "clean" });
    const top = await makeFile(row.id, null, { scanStatus: "clean" });
    const reported = await makeLink(deep.id, row.id, ["report"]);
    const plain = await makeLink(top.id, row.id);

    expect(await status(client)).toEqual({ scheduledFor: null });
    await scheduleDeletion(client, email);
    const scheduled = await status(client);
    const at = Date.parse(scheduled.scheduledFor!);
    expect(at - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(at - Date.now()).toBeLessThan(7.1 * 86_400_000);
    expect((await linkById(reported.id)).pauseReasons.sort()).toEqual(["owner_deletion", "report"]);
    expect((await linkById(plain.id)).pauseReasons).toEqual(["owner_deletion"]);

    // Another sign-in, in another browser, during the window: still scheduled.
    const again = newClient();
    expect((await signIn(again, email)).status).toBe(200);
    expect(await status(again)).toEqual(scheduled);
    expect((await userById(row.id))!.deleteScheduledAt).not.toBeNull();

    const cancelled = await send(client, "/api/account/deletion/cancel", { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect(await status(client)).toEqual({ scheduledFor: null });
    const stillPaused = await linkById(reported.id);
    expect(stillPaused.pauseReasons).toEqual(["report"]);
    expect(stillPaused.pausedAt).not.toBeNull();
    const live = await linkById(plain.id);
    expect(live.pauseReasons).toEqual([]);
    expect(live.pausedAt).toBeNull();
  });

  it("a held account: the same status body and the same profile as an unheld one, before and after the request", async () => {
    const held = await verifiedUser({ name: "Same Name" });
    const free = await verifiedUser({ name: "Same Name" });
    await testDb().update(user).set({ legalHold: true }).where(eq(user.id, held.user.id));
    const view = async (who: typeof held) => {
      const profile = await send(who.client, "/api/account/profile");
      const deletion = await send(who.client, "/api/account/deletion-status");
      return {
        profile: [profile.status, profile.text.replace(who.email, "EMAIL")],
        deletion: [deletion.status, deletion.text.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/, "DATE")],
      };
    };
    expect(await view(held)).toEqual(await view(free));
    await scheduleDeletion(held.client, held.email);
    await scheduleDeletion(free.client, free.email);
    const a = await view(held);
    expect(a).toEqual(await view(free));
    expect(a.deletion[1]).toBe('{"scheduledFor":"DATE"}');
    expect(a.profile[1]).not.toMatch(/hold/i);
    // The same mails went out.
    expect(
      mailTo(held.email)
        .map((mail) => mail.template)
        .sort(),
    ).toEqual(
      mailTo(free.email)
        .map((mail) => mail.template)
        .sort(),
    );
  });
});

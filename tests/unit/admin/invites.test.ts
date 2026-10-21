// Invites (T25 section 9): create, list, revoke, and the CSV export of codes.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, invites } from "../../../src/worker/db/schema";
import { csvCell } from "../../../src/worker/routes/admin";
import { admin, adminCall, rand, testDb } from "./helpers";

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}(-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}){3}$/;

describe("invites", () => {
  it("creates N codes in the read-aloud alphabet with uses, expiry and note; the audit row counts, never names, them", async () => {
    const who = await admin();
    const note = `wave ${rand()}`;
    const created = await adminCall(who.as, "POST", "/invites", {
      body: { count: 3, maxUses: 2, expiresAt: "2099-01-01T00:00:00.000Z", note },
    });
    expect(created.status).toBe(200);
    expect(created.body.invites).toHaveLength(3);
    for (const invite of created.body.invites) {
      expect(invite.code).toMatch(CODE);
      expect(invite).toMatchObject({
        maxUses: 2,
        uses: 0,
        expiresAt: "2099-01-01T00:00:00.000Z",
        note,
        createdBy: who.id,
      });
    }
    const rows = (await testDb().select().from(invites).where(eq(invites.note, note))).length;
    expect(rows).toBe(3);
    const audit = (await testDb().select().from(auditLog).where(eq(auditLog.actorUserId, who.id))).filter(
      (row) => row.action === "admin.invites_created",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.meta).toEqual({ count: 3, maxUses: 2 });
    for (const invite of created.body.invites) expect(JSON.stringify(audit[0])).not.toContain(invite.code);
  });

  it("lists newest first, a page at a time", async () => {
    const who = await admin();
    await adminCall(who.as, "POST", "/invites", { body: { count: 3 } });
    const first = await adminCall(who.as, "GET", "/invites?limit=2");
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await adminCall(who.as, "GET", `/invites?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.length).toBeGreaterThan(0);
    const ids = [...first.body.items, ...second.body.items].map((i: { code: string }) => i.code);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("revoke sets revokedAt, is audited, and is a 404 for an unknown code", async () => {
    const who = await admin();
    const [invite] = (await adminCall(who.as, "POST", "/invites", { body: { count: 1 } })).body.invites;
    const revoked = await adminCall(who.as, "POST", `/invites/${invite.code}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedAt).not.toBeNull();
    const [row] = await testDb().select().from(invites).where(eq(invites.code, invite.code));
    expect(row!.revokedAt).not.toBeNull();
    expect((await adminCall(who.as, "POST", `/invites/NO-SUCH-${rand()}/revoke`)).status).toBe(404);
    const audit = (await testDb().select().from(auditLog).where(eq(auditLog.actorUserId, who.id))).filter(
      (r) => r.action === "admin.invite_revoked",
    );
    expect(audit).toHaveLength(1);
  });

  it("CSV export: a text/csv attachment with the header and every code", async () => {
    const who = await admin();
    const note = `csv ${rand()}`;
    const [invite] = (await adminCall(who.as, "POST", "/invites", { body: { count: 1, note } })).body.invites;
    const csv = await adminCall(who.as, "GET", "/invites/export");
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(csv.headers.get("content-disposition")).toContain("attachment");
    expect(csv.text.split("\r\n")[0]).toBe(
      '"code","maxUses","uses","expiresAt","revokedAt","note","createdAt"',
    );
    expect(csv.text).toContain(`"${invite.code}"`);
    expect(csv.text).toContain(`"${note}"`);
  });

  it("a CSV cell is quoted, and a leading formula character is neutralised", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    for (const lead of ["+", "-", "@", "\t", "\r"]) expect(csvCell(`${lead}x`)).toBe(`"'${lead}x"`);
    expect(csvCell(null)).toBe('""');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

// The audit log viewer (T25 section 10): filters, paging, who each actor is ("deleted account"
// for an id with no account; "system" for no id), and the streamed CSV export. No address hash
// ever leaves.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, user } from "../../../src/worker/db/schema";
import { admin, adminCall, baId, member, rand, testDb } from "./helpers";

/** Audit rows of one made-up action, for this test alone. */
async function rows(action: string, values: Partial<typeof auditLog.$inferInsert>[]) {
  const inserted = [];
  for (const [index, value] of values.entries()) {
    const [row] = await testDb()
      .insert(auditLog)
      .values({
        action,
        actorType: "admin",
        ipHashDaily: `made-up-hash-${rand(6)}`,
        at: new Date(Date.UTC(2099, 0, 1 + index)),
        ...value,
      })
      .returning();
    inserted.push(row!);
  }
  return inserted;
}

describe("the audit view", () => {
  it("filters by action, actor, target and date; pages newest first; never answers the address hash", async () => {
    const who = await admin();
    const actor = await member();
    const action = `test.view.${rand()}`;
    const target = baId();
    const made = await rows(action, [
      { actorUserId: actor.id, targetType: "user", targetId: target },
      { actorUserId: actor.id, targetType: "user", targetId: baId() },
      { actorUserId: null, actorType: "system", targetType: "job", targetId: "purge" },
    ]);
    const all = await adminCall(who.as, "GET", `/audit?action=${action}`);
    expect(all.status).toBe(200);
    expect(all.body.items.map((r: { id: string }) => r.id)).toEqual([made[2]!.id, made[1]!.id, made[0]!.id]);
    expect(all.text).not.toMatch(/ipHash|ip_hash|made-up-hash/);

    const byActor = await adminCall(who.as, "GET", `/audit?action=${action}&actorUserId=${actor.id}`);
    expect(byActor.body.items).toHaveLength(2);
    const byTarget = await adminCall(
      who.as,
      "GET",
      `/audit?action=${action}&targetType=user&targetId=${target}`,
    );
    expect(byTarget.body.items.map((r: { id: string }) => r.id)).toEqual([made[0]!.id]);
    const byDate = await adminCall(
      who.as,
      "GET",
      `/audit?action=${action}&from=2099-01-02T00:00:00.000Z&to=2099-01-02T23:59:59.000Z`,
    );
    expect(byDate.body.items.map((r: { id: string }) => r.id)).toEqual([made[1]!.id]);

    const first = await adminCall(who.as, "GET", `/audit?action=${action}&limit=2`);
    expect(first.body.items).toHaveLength(2);
    const second = await adminCall(
      who.as,
      "GET",
      `/audit?action=${action}&limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.body.items.map((r: { id: string }) => r.id)).toEqual([made[0]!.id]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("actors: a known account by name, a deleted one as null, a row with no actor stays (system)", async () => {
    const who = await admin();
    const gone = await member();
    const known = await member();
    const action = `test.actors.${rand()}`;
    await rows(action, [
      { actorUserId: gone.id },
      { actorUserId: known.id },
      { actorUserId: null, actorType: "system" },
    ]);
    await testDb().delete(user).where(eq(user.id, gone.id));
    const view = await adminCall(who.as, "GET", `/audit?action=${action}`);
    expect(view.status).toBe(200);
    expect(view.body.items).toHaveLength(3);
    expect(view.body.actors[gone.id]).toBeNull();
    expect(view.body.actors[known.id]).toEqual({ id: known.id, displayName: known.row.name });
    expect(
      view.body.items.find((r: { actorUserId: string | null }) => r.actorUserId === null).actorType,
    ).toBe("system");
  });

  it("the CSV export streams every matching row under the header, escaped (quotes, newlines, formula prefixes), and no address hash", async () => {
    const who = await admin();
    const action = `test.csv.${rand()}`;
    const many = Array.from({ length: 503 }, (_, i) => ({
      actorUserId: null,
      actorType: "system" as const,
      targetId: `t${i}`,
      at: new Date(Date.UTC(2099, 1, 1, 0, 0, i)),
    }));
    await rows(action, many);
    await rows(action, [
      { actorUserId: null, actorType: "system", targetId: "=SUM(A1)", meta: { note: 'he said "x"\nnext' } },
    ]);
    const csv = await adminCall(who.as, "GET", `/audit/export?action=${action}`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
    const lines = csv.text.split("\r\n").filter((line) => line !== "");
    expect(lines[0]).toBe(
      '"id","at","actorUserId","actorType","action","targetType","targetId","ua","country","requestId","meta"',
    );
    // 503 rows cross the 500-row batch; the odd row's newline is inside its quoted cell.
    expect(csv.text.split(`"${action}"`).length - 1).toBe(504);
    expect(csv.text).toContain(`"'=SUM(A1)"`);
    expect(csv.text).toContain('""x\\""');
    expect(csv.text).not.toMatch(/made-up-hash/);
  });
});

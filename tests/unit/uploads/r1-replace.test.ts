// R1 func-7: a second replace of a file while one is still being uploaded is refused at init
// (`409 replace_in_progress`), before a large file is sent for nothing.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { uploads } from "../../../src/worker/db/schema";
import { makeFile, testDb } from "../services-core/helpers";
import { call, init, initBody, sessionRow, uploader } from "./helpers";

const post = (caller: Parameters<typeof call>[0], json: unknown) =>
  call(caller, "POST", "/uploads", { json });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe("func-7: one replace of a file at a time", () => {
  async function target() {
    const user = await uploader();
    const file = await makeFile(user.id, null, { name: "plan.txt", scanStatus: "clean" });
    const body = (size: number) =>
      initBody({ name: "plan.txt", replaceNodeId: file.id, onConflict: "replace", size });
    return { user, file, body };
  }

  it("a second replace while the first is open: 409 replace_in_progress, nothing created", async () => {
    const { user, body } = await target();
    const first = await init(user, body(10));
    const second = await post(user, body(20));
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: "replace_in_progress" });
    const sessions = await testDb().select().from(uploads).where(eq(uploads.uploaderId, user.id));
    expect(sessions.map((row) => row.id)).toEqual([first.uploadId]);
  });

  it("…and while the first is completing", async () => {
    const { user, body } = await target();
    const first = await init(user, body(10));
    await testDb()
      .update(uploads)
      .set({ status: "completing", completingAt: new Date() })
      .where(eq(uploads.id, first.uploadId));
    expect((await post(user, body(20))).status).toBe(409);
  });

  it("CONTROL: the same local file again is the resume (200, the same session); an ended first replace frees the file", async () => {
    const { user, body } = await target();
    const first = await init(user, body(10));
    const again = await post(user, body(10));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ uploadId: first.uploadId });
    await testDb().update(uploads).set({ status: "aborted" }).where(eq(uploads.id, first.uploadId));
    expect((await post(user, body(20))).status).toBe(201);
    expect(await sessionRow(first.uploadId)).toMatchObject({ status: "aborted" });
  });

  it("CONTROL: an expired first replace does not block the file", async () => {
    const { user, body } = await target();
    const first = await init(user, body(10));
    await testDb()
      .update(uploads)
      .set({ expiresAt: minutesAgo(1) })
      .where(eq(uploads.id, first.uploadId));
    expect((await post(user, body(20))).status).toBe(201);
  });
});

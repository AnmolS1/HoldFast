// R1 func-13: a session left `completing` by a closed tab (the avatar's 120 s wait) or an expired
// `open` one no longer holds a place under MAX_OPEN_UPLOADS (dev has no stale-uploads job to end
// them).
import { describe, expect, it } from "vitest";
import { MAX_OPEN_UPLOADS } from "../../../src/shared/constants";
import { COMPLETING_STALE_MINUTES } from "../../../src/worker/db/queries/uploads";
import { makeUpload } from "../services-core/helpers";
import { call, initBody, uploader } from "./helpers";

const post = (caller: Parameters<typeof call>[0], json: unknown) =>
  call(caller, "POST", "/uploads", { json });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe("func-13: the open-session cap counts only sessions that can still finish", () => {
  it("stale completing and expired open sessions do not hold a place", async () => {
    const user = await uploader();
    for (let i = 0; i < MAX_OPEN_UPLOADS; i++) {
      await makeUpload(
        user.id,
        user.id,
        i % 2
          ? { status: "completing", completingAt: minutesAgo(COMPLETING_STALE_MINUTES + 1) }
          : { status: "open", expiresAt: minutesAgo(1) },
      );
    }
    expect((await post(user, initBody())).status).toBe(201);
  });

  it("CONTROL: fresh completing and unexpired open sessions still do", async () => {
    const user = await uploader();
    for (let i = 0; i < MAX_OPEN_UPLOADS; i++) {
      await makeUpload(
        user.id,
        user.id,
        i % 2 ? { status: "completing", completingAt: minutesAgo(COMPLETING_STALE_MINUTES - 1) } : {},
      );
    }
    const refused = await post(user, initBody());
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: "ceiling_exceeded", details: { kind: "open_uploads" } });
  });
});

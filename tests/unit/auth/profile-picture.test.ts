// `user.image` stays empty (R1 legal-6 / secsrv-n4): nothing in the app reads it, and the privacy
// text names only the name, address and account id Google shares. Better Auth's Google provider
// maps the profile's `picture` to `image` (@better-auth/core social-providers/google.mjs), and its
// `/update-user` takes any `image` string — neither may store one.
import { describe, expect, it } from "vitest";
import { testGoogleCode, type TestGoogleProfile } from "../../../src/worker/auth/test-outbound";
import { createInvite, freshEmail, newClient, send, userByEmail, verifiedUser, type Client } from "./helpers";

// A made-up picture address: nothing is fetched from it.
const PICTURE = "https://lh3.googleusercontent.example/zz-made-up-picture.jpg";

/** The browser's part of a Google sign-up (as google.test.ts drives it). */
async function googleSignUp(client: Client, profile: TestGoogleProfile) {
  const intent = await send(client, "/api/auth-intent", {
    json: { birthYear: 1990, birthMonth: 5, acceptTerms: true, inviteCode: await createInvite() },
  });
  expect(intent.status, intent.text).toBe(200);
  const start = await send(client, "/api/auth/sign-in/social", {
    json: { provider: "google", callbackURL: "/", errorCallbackURL: "/signup" },
  });
  expect(start.status, start.text).toBe(200);
  const state = new URL((start.body as { url: string }).url).searchParams.get("state")!;
  return send(
    client,
    `/api/auth/callback/google?code=${encodeURIComponent(testGoogleCode(profile))}&state=${encodeURIComponent(state)}`,
    { browser: false },
  );
}

describe("user.image", () => {
  it("a Google sign-up does not store the profile picture", async () => {
    const email = freshEmail();
    // The stand-in token endpoint puts the whole profile in the id_token, `picture` included.
    const profile = { sub: `g-${crypto.randomUUID()}`, email, name: "Gina Google", picture: PICTURE };
    const callback = await googleSignUp(newClient(), profile as TestGoogleProfile);
    expect(callback.status).toBe(302);
    // The control: the account WAS created from that profile.
    const row = await userByEmail(email);
    expect(row).toMatchObject({ email, name: "Gina Google" });
    expect(row!.image).toBeNull();
  });

  it("/update-user refuses an `image` (400) and stores nothing; the name alone is still accepted", async () => {
    const { client, email } = await verifiedUser();
    const refused = await send(client, "/api/auth/update-user", { json: { image: PICTURE } });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: "validation", details: { fields: ["image"] } });
    expect((await userByEmail(email))!.image).toBeNull();
    const named = await send(client, "/api/auth/update-user", { json: { name: "Renamed Person" } });
    expect(named.status, named.text).toBe(200);
    expect((await userByEmail(email))!.name).toBe("Renamed Person");
  });
});

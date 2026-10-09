// A2, the passkey row: a passkey sign-in counts as a second factor only when the assertion
// carried the USER VERIFIED flag.
//
// The passkey plugin never requires user verification
// (@better-auth/passkey/dist/index.mjs: `requireUserVerification: false` in both ceremonies,
// `userVerification: "preferred"` in the options it issues), so a key that only proves presence
// — a security key with no PIN, tapped by whoever holds it — signs in. That is ONE factor. The
// plugin hands the verified assertion to `authentication.afterVerification`, and
// `authenticationInfo.userVerified` (@simplewebauthn/server) is what auth/second-factor.ts reads.
// And any fresh session may register a passkey, so a verified assertion counts only for a key
// that a session which had itself passed a second factor registered.
//
// A browser's virtual authenticator cannot produce a discoverable credential that skips user
// verification, so the authenticator here is software: a P-256 key, "none" attestation, and the
// flags byte under the test's control. Everything else is the real handler.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testGoogleCode } from "../../../src/worker/auth/test-outbound";
import { user } from "../../../src/worker/db/schema";
import { enableTotp, newClient, send, sessionsOf, testDb, verifiedUser, type Client } from "./helpers";

const RP_ID = "localhost";
const ORIGIN = "http://localhost";
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

// ── just enough CBOR (RFC 8949) for an attestation object and a COSE key ────────────────────
function head(major: number, value: number): Uint8Array {
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value < 256) return Uint8Array.of((major << 5) | 24, value);
  return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
}
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;
function cbor(value: Cbor): Uint8Array {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const text = encoder.encode(value);
    return concat(head(3, text.length), text);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  const entries = [...value].map(([key, item]) => concat(cbor(key), cbor(item)));
  return concat(head(5, value.size), ...entries);
}

/** A raw (r‖s) ECDSA signature as the ASN.1 DER sequence WebAuthn carries. */
function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const body = bytes.slice(start);
    const padded = body[0]! & 0x80 ? concat(Uint8Array.of(0), body) : body;
    return concat(Uint8Array.of(0x02, padded.length), padded);
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return concat(Uint8Array.of(0x30, r.length + s.length), r, s);
}

type SoftKey = { id: Uint8Array; keys: CryptoKeyPair; counter: number };

/** Registers a new software passkey for the signed-in `client`. */
async function registerPasskey(client: Client): Promise<SoftKey> {
  const options = await send(client, "/api/auth/passkey/generate-register-options");
  expect(options.status, options.text).toBe(200);
  const { challenge } = options.body as { challenge: string };
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  const id = crypto.getRandomValues(new Uint8Array(32));
  const coseKey = cbor(
    new Map<number, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, publicRaw.slice(1, 33)],
      [-3, publicRaw.slice(33, 65)],
    ]),
  );
  const authData = concat(
    await sha256(encoder.encode(RP_ID)),
    Uint8Array.of(UP | UV | AT),
    Uint8Array.of(0, 0, 0, 0),
    new Uint8Array(16), // AAGUID
    Uint8Array.of(id.length >> 8, id.length & 0xff),
    id,
    coseKey,
  );
  const attestationObject = cbor(
    new Map<string, Cbor>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]),
  );
  const clientDataJSON = encoder.encode(
    JSON.stringify({ type: "webauthn.create", challenge, origin: ORIGIN, crossOrigin: false }),
  );
  const verified = await send(client, "/api/auth/passkey/verify-registration", {
    json: {
      name: "software key",
      response: {
        id: b64url(id),
        rawId: b64url(id),
        type: "public-key",
        response: {
          clientDataJSON: b64url(clientDataJSON),
          attestationObject: b64url(attestationObject),
          transports: ["usb"],
        },
        clientExtensionResults: {},
      },
    },
  });
  expect(verified.status, verified.text).toBe(200);
  return { id, keys, counter: 0 };
}

/** A sign-in with the key from a browser that has no session; `flags` is what the key asserts. */
async function signInWithPasskey(client: Client, key: SoftKey, userId: string, flags: number) {
  const options = await send(client, "/api/auth/passkey/generate-authenticate-options");
  expect(options.status, options.text).toBe(200);
  const { challenge } = options.body as { challenge: string };
  key.counter += 1;
  const authenticatorData = concat(
    await sha256(encoder.encode(RP_ID)),
    Uint8Array.of(flags),
    Uint8Array.of(0, 0, 0, key.counter),
  );
  const clientDataJSON = encoder.encode(
    JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }),
  );
  const signed = concat(authenticatorData, await sha256(clientDataJSON));
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.keys.privateKey, signed),
  );
  return send(client, "/api/auth/passkey/verify-authentication", {
    json: {
      response: {
        id: b64url(key.id),
        rawId: b64url(key.id),
        type: "public-key",
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authenticatorData),
          signature: b64url(derSignature(raw)),
          userHandle: b64url(encoder.encode(userId)),
        },
        clientExtensionResults: {},
      },
    },
  });
}

/** An admin with a real TOTP enrolment and a registered passkey; nobody signed in afterwards. */
async function adminWithPasskey() {
  const made = await verifiedUser();
  await enableTotp(made.client);
  const key = await registerPasskey(made.client);
  await testDb().update(user).set({ role: "admin" }).where(eq(user.id, made.user.id));
  await send(made.client, "/api/auth/sign-out", { json: {} });
  expect(await sessionsOf(made.user.id)).toEqual([]);
  return { ...made, key };
}

const adminCall = async (client: Client) => {
  const target = await verifiedUser();
  return send(client, "/api/auth/admin/set-role", { json: { userId: target.user.id, role: "user" } });
};

describe("a passkey sign-in and the session's second factor", () => {
  it("presence only (no user verification): a session, but NOT a second factor — admin_requires_2fa", async () => {
    const admin = await adminWithPasskey();
    const browser = newClient();
    const signedIn = await signInWithPasskey(browser, admin.key, admin.user.id, UP);
    expect(signedIn.status, signedIn.text).toBe(200);
    const rows = await sessionsOf(admin.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.secondFactorAt).toBeNull();
    const refused = await adminCall(browser);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "ADMIN_REQUIRES_2FA", error: "admin_requires_2fa" });
  });

  it("with user verification: the session carries it, and the admin call passes", async () => {
    const admin = await adminWithPasskey();
    const browser = newClient();
    const signedIn = await signInWithPasskey(browser, admin.key, admin.user.id, UP | UV);
    expect(signedIn.status, signedIn.text).toBe(200);
    const rows = await sessionsOf(admin.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.secondFactorAt).toBeInstanceOf(Date);
    expect((await adminCall(browser)).status).toBe(200);
  });

  it("the flag is read per sign-in: a verified one does not make a later presence-only one count", async () => {
    const admin = await adminWithPasskey();
    const first = newClient();
    expect((await signInWithPasskey(first, admin.key, admin.user.id, UP | UV)).status).toBe(200);
    const second = newClient();
    expect((await signInWithPasskey(second, admin.key, admin.user.id, UP)).status).toBe(200);
    const rows = await sessionsOf(admin.user.id);
    expect(rows.map((row) => row.secondFactorAt !== null).sort()).toEqual([false, true]);
    expect((await adminCall(second)).status).toBe(403);
    expect((await adminCall(first)).status).toBe(200);
  });

  it("a key PLANTED by a one-factor session never counts — user verification or not", async () => {
    // The attack: a stolen session that has not passed the second factor (here: Google-made)
    // registers a passkey of its own, signs in with it "with user verification", and would come
    // back as a two-factor session.
    const admin = await adminWithPasskey();
    const stolen = newClient();
    const start = await send(stolen, "/api/auth/sign-in/social", {
      json: { provider: "google", callbackURL: "/", errorCallbackURL: "/login" },
    });
    const state = new URL((start.body as { url: string }).url).searchParams.get("state")!;
    const code = testGoogleCode({ sub: `g-${crypto.randomUUID()}`, email: admin.email, name: "G" });
    await send(
      stolen,
      `/api/auth/callback/google?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      { browser: false },
    );
    expect((await sessionsOf(admin.user.id)).map((row) => row.secondFactorAt)).toEqual([null]);
    const planted = await registerPasskey(stolen);
    await send(stolen, "/api/auth/sign-out", { json: {} });

    const attacker = newClient();
    expect((await signInWithPasskey(attacker, planted, admin.user.id, UP | UV)).status).toBe(200);
    expect((await sessionsOf(admin.user.id)).map((row) => row.secondFactorAt)).toEqual([null]);
    expect((await adminCall(attacker)).status).toBe(403);
    // The owner's own key — registered by a session that had passed the factor — still counts.
    const owner = newClient();
    expect((await signInWithPasskey(owner, admin.key, admin.user.id, UP | UV)).status).toBe(200);
    expect((await adminCall(owner)).status).toBe(200);
  });

  it("a key registered before the account had two-factor does not start counting when it is switched on", async () => {
    const made = await verifiedUser();
    const early = await registerPasskey(made.client);
    await enableTotp(made.client);
    await testDb().update(user).set({ role: "admin" }).where(eq(user.id, made.user.id));
    await send(made.client, "/api/auth/sign-out", { json: {} });
    const browser = newClient();
    expect((await signInWithPasskey(browser, early, made.user.id, UP | UV)).status).toBe(200);
    expect((await sessionsOf(made.user.id)).map((row) => row.secondFactorAt)).toEqual([null]);
    expect((await adminCall(browser)).status).toBe(403);
  });

  it("a signature that does not verify makes no session at all (the software key is really checked)", async () => {
    const admin = await adminWithPasskey();
    const other = { ...admin.key, keys: (await adminWithPasskey()).key.keys };
    const refused = await signInWithPasskey(newClient(), other, admin.user.id, UP | UV);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await sessionsOf(admin.user.id)).toEqual([]);
  });
});

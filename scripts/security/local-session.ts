// A throwaway signed-in account on a LOCAL `vite dev` — for the security scripts' local smoke runs
// (ratelimit-probe.ts, timing-residuals.ts). A deploy is never signed up to: there the session
// comes from scripts/create-session.ts.
//
//   npx tsx scripts/security/local-session.ts --base http://localhost:5190 --out "$DIR/session.json"
//
// It signs up through the test Turnstile token with an invite written to the checkout's own
// database (DATABASE_URL_DIRECT, local only), follows the verification link from the test outbox
// with the browser's mailbox proof, and writes { header, user: { id } } — the shape of
// create-session.ts's file — mode 600, outside the repository. Nothing secret is printed.

import { chmodSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { classifyTarget, outsideRepo } from "../lib/session-target";

// Made up for throwaway local accounts; they never leave this machine.
const LOCAL_PASSWORD = "correct horse battery staple 9!";
const TURNSTILE_TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const rand = (n: number) =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(n)),
    (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36],
  ).join("");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Cookie header of a fresh verified account's session, and its id. */
export async function localSession(
  base: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ header: string; user: { id: string } }> {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(base).hostname))
    throw new Error("local-session: a local vite dev only");
  const target = classifyTarget(process.env.DATABASE_URL_DIRECT, {});
  if (target.target !== "local")
    throw new Error("local-session: DATABASE_URL_DIRECT is not a local database");
  const db = new pg.Client({ connectionString: target.url });
  await db.connect();
  const code = `PROBE-${rand(10).toUpperCase()}`;
  try {
    await db.query("INSERT INTO invites (code, max_uses, note) VALUES ($1, 1, 'security scripts')", [code]);
  } finally {
    await db.end();
  }
  const email = `probe-${rand(10)}@security-scripts.example`;
  const browser = { origin: base, "sec-fetch-site": "same-origin", ...extraHeaders };
  const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { ...browser, "content-type": "application/json", "x-captcha-response": TURNSTILE_TEST_TOKEN },
    body: JSON.stringify({
      email,
      password: LOCAL_PASSWORD,
      name: "Probe",
      inviteCode: code,
      birthYear: 1990,
      birthMonth: 5,
      acceptTerms: true,
      callbackURL: "/login?reason=verified",
    }),
  });
  if (!signUp.ok) throw new Error(`local sign-up: ${signUp.status}`);
  // The browser that signed up holds the mailbox proof; the link signs in only with it.
  const pending = signUp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .join("; ");
  let link: string | undefined;
  for (let attempt = 0; attempt < 50 && !link; attempt++) {
    const outbox = await fetch(`${base}/api/_test/outbox?to=${encodeURIComponent(email)}`, {
      headers: extraHeaders,
    });
    link = /https?:\/\/[^\s"'<>\\]+\/api\/auth\/verify-email[^\s"'<>\\]+/.exec(await outbox.text())?.[0];
    if (!link) await sleep(100);
  }
  if (!link) throw new Error("local sign-up: no verification mail in the test outbox");
  const verified = await fetch(link.replace(/&amp;/g, "&"), {
    headers: { ...extraHeaders, cookie: pending },
    redirect: "manual",
  });
  const cookie = verified.headers.getSetCookie().find((c) => /^(__Host-)?hf\.session_token=/.test(c));
  if (!cookie)
    throw new Error(`local sign-up: the verification answered ${verified.status} without a session`);
  const header = cookie.split(";")[0]!;
  const read = await fetch(`${base}/api/auth/get-session`, { headers: { ...extraHeaders, cookie: header } });
  const id = ((await read.json()) as { user?: { id?: string } } | null)?.user?.id;
  if (!id) throw new Error("local sign-up: the new session reads as signed out");
  return { header, user: { id } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { base: { type: "string" }, out: { type: "string" } } });
  if (!values.base || !values.out) {
    console.error("usage: local-session.ts --base <local app origin> --out <file outside the repository>");
    process.exit(2);
  }
  const out = outsideRepo(values.out);
  // An address of its own (the Worker trusts CF-Connecting-IP locally): Better Auth allows five
  // sign-ups an hour per address.
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  const address = `198.51.${100 + (bytes[0]! % 100)}.${1 + (bytes[1]! % 254)}`;
  localSession(new URL(values.base).origin, { "cf-connecting-ip": address })
    .then((made) => {
      writeFileSync(out, `${JSON.stringify(made, null, 2)}\n`, { mode: 0o600 });
      chmodSync(out, 0o600);
      console.log("local-session: a throwaway account's session is at --out (mode 600)");
    })
    .catch((error: unknown) => {
      console.error(`local-session: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}

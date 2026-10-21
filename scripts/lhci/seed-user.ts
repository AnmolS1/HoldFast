// A verified user for the authenticated Lighthouse run, made the way the e2e suite makes one (T06's
// `signedInUser`: an invite in this checkout's database, a real sign-up, the verification link from
// the memory outbox). Local only — the server must be this checkout's, on the memory mail transport.
//
//   npx tsx scripts/lhci/seed-user.ts <credentials.json>
//
// Writes { email, password } to the file (mode 600; the password is the fixture's made-up one).
import { chmodSync, writeFileSync } from "node:fs";
import { request } from "@playwright/test";
import { signedInUser } from "../../tests/setup/auth-fixtures";
import { appOrigin, e2ePort } from "../../tests/setup/local-env";

const out = process.argv[2];
if (!out) throw new Error("usage: seed-user.ts <credentials.json>");
const api = await request.newContext({ baseURL: appOrigin(e2ePort()) });
try {
  // An address of this run's own for the sign-up limits (3 a day per address).
  const clientIp = `10.250.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  const user = await signedInUser(api, { clientIp, name: "Lighthouse" });
  writeFileSync(out, JSON.stringify({ email: user.email, password: user.password }));
  chmodSync(out, 0o600);
  console.log("seed-user: a verified user for the authenticated run is ready");
} finally {
  await api.dispose();
}

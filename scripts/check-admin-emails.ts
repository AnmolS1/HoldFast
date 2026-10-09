// Checks an ADMIN_EMAILS value with the Worker's own parser (src/shared/admin-emails.ts): every
// entry must be ONE plain, exact address — no wildcard, no pattern, no display name. An entry
// that is not is IGNORED by the Worker (it grants nothing), which is safe and almost certainly
// not what was meant; this script makes it a failure before the value is ever uploaded.
//
//   ADMIN_EMAILS=… npx tsx scripts/check-admin-emails.ts            the process environment's value
//   … | npx tsx scripts/check-admin-emails.ts --stdin               the value on standard input
//   npx tsx scripts/check-admin-emails.ts --self-test
//
// It prints COUNTS only — never an address, never an entry — and exits 1 when an entry is not a
// plain address, or when there is no address at all (a deploy with no bootstrap admin).

import { readFileSync } from "node:fs";
import { parseAdminList } from "../src/shared/admin-emails";

export function verdict(value: string | undefined): { ok: boolean; line: string } {
  const list = parseAdminList(value ?? "");
  const addresses = list.addresses.size;
  const line =
    `ADMIN_EMAILS: ${addresses} exact address${addresses === 1 ? "" : "es"}, ` +
    `${list.invalid} entr${list.invalid === 1 ? "y" : "ies"} that ${list.invalid === 1 ? "is" : "are"} not a plain address`;
  return { ok: list.invalid === 0 && addresses > 0, line };
}

function selfTest(): boolean {
  const cases: Array<[string, boolean]> = [
    ["ana@example.com", true],
    [" Ana@Example.com , bo@example.org ", true],
    ["", false],
    [" , ", false],
    ["*@example.com", false],
    ["ana@example.com, *@example.com", false],
    ["Ana <ana@example.com>", false],
    ["ana@example.com;bo@example.com", false],
    ["ana@example.com bo@example.com", false],
    ["example.com", false],
    ["/.*@example\\.com/", false],
  ];
  let wrong = 0;
  for (const [value, expected] of cases) {
    const got = verdict(value);
    if (got.ok !== expected) wrong += 1;
    // Never the value: its position in the table only.
    console.log(
      `  ${got.ok === expected ? "ok   " : "WRONG"} case ${cases.findIndex(([v]) => v === value) + 1} → ${got.ok ? "pass" : "fail"}`,
    );
    if (/@|example/.test(got.line)) wrong += 1;
  }
  console.log(
    wrong === 0 ? "check-admin-emails --self-test: OK" : `check-admin-emails --self-test: ${wrong} wrong`,
  );
  return wrong === 0;
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  process.exitCode = selfTest() ? 0 : 1;
} else {
  const value = args.includes("--stdin") ? readFileSync(0, "utf8").trim() : process.env.ADMIN_EMAILS;
  const { ok, line } = verdict(value);
  console.log(line);
  if (!ok) {
    console.error(
      "check-admin-emails: FAIL — the list must be comma-separated exact addresses, at least one",
    );
    process.exitCode = 1;
  }
}

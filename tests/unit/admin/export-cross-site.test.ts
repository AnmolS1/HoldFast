// secsrv-3 (admin half): the console's three export GETs — the DMCA notice's printable copy, the
// invites CSV and the audit CSV — are navigations a page on another site could start in an admin's
// browser (the session cookie is SameSite=Lax; the CSRF middleware passes every GET). Each writes
// an audit row and reads personal data, so `Sec-Fetch-Site: cross-site | same-site` is refused
// (403, reason csrf) before anything runs. `same-origin`, `none` (typed, bookmarked) and an absent
// header (an older browser) are served.
import { describe, expect, it } from "vitest";
import { admin, adminCall, auditOf } from "./helpers";
import { openNoticeOn } from "../trash/helpers";
import { makeFile, member } from "./helpers";

const exports_ = async () => {
  const owner = await member();
  const file = await makeFile(owner.id, null, { scanStatus: "clean" });
  const notice = await openNoticeOn(file.id);
  return [`/dmca/${notice}/export`, "/invites/export", "/audit/export"];
};

describe("the admin export GETs refuse a cross-site start", () => {
  it("cross-site and same-site → 403 csrf, nothing audited; same-origin, none and absent → 200", async () => {
    const who = await admin();
    for (const path of await exports_()) {
      for (const site of ["cross-site", "same-site"]) {
        const answer = await adminCall(who.as, "GET", path, { headers: { "sec-fetch-site": site } });
        expect([answer.status, answer.body?.details?.reason], `${site} ${path}`).toEqual([403, "csrf"]);
      }
      for (const site of ["same-origin", "none", null]) {
        const answer = await adminCall(who.as, "GET", path, {
          headers: site ? { "sec-fetch-site": site } : {},
        });
        expect(answer.status, `${site} ${path}`).toBe(200);
      }
    }
    const [dmca] = await exports_();
    const noticeId = dmca!.split("/")[2]!;
    await adminCall(who.as, "GET", dmca!, { headers: { "sec-fetch-site": "cross-site" } });
    expect(await auditOf("admin.dmca_exported", noticeId)).toHaveLength(0);
  });
});

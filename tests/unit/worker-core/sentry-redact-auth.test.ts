// What a request under /api/auth/* puts in a Sentry event beyond the token-bearing paths: the
// OAuth `state`, an error redirect's free text, the client's raw address, the full User-Agent.
// Sentry's own request capture runs for these routes like for any other, and `redactEvent` is
// what stands between it and Sentry.
import { describe, expect, it } from "vitest";
import { redactEvent, redactText, userAgentFamily } from "../../../src/shared/sentry-redact";

describe("redactEvent on a request under /api/auth/*", () => {
  it("an OAuth callback: the `state` value goes like the `code` does", () => {
    const url = "/api/auth/callback/google?code=SENTINEL-CODE&state=SENTINEL-STATE&scope=email";
    expect(redactText(url)).not.toContain("SENTINEL-STATE");
    const event = redactEvent({
      request: {
        url: "https://app.example/api/auth/callback/google",
        query_string: "code=C&state=SENTINEL-STATE",
      },
    });
    expect(JSON.stringify(event)).not.toContain("SENTINEL-STATE");
  });

  it("an error redirect: `error_description` is free text from a provider or a hook and is not kept", () => {
    const url = "/login?error=access_denied&error_description=Sentinel+Person+is+not+allowed";
    expect(redactText(url)).not.toContain("Sentinel");
  });

  it("request headers: no raw client address, and no User-Agent beyond what a family needs", () => {
    const event = redactEvent({
      request: {
        url: "https://app.example/api/auth/sign-in/email",
        headers: {
          "cf-connecting-ip": "203.0.113.77",
          "x-forwarded-for": "203.0.113.77, 198.51.100.4",
          "x-real-ip": "203.0.113.77",
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15",
        },
      },
    });
    const text = JSON.stringify(event);
    expect(text).not.toContain("203.0.113.77");
    expect(text).not.toContain("198.51.100.4");
    expect(text).not.toContain("AppleWebKit/605.1.15");
    expect(text).not.toContain("Mac OS X");
    // What is kept of the User-Agent: the family, whatever the header's spelling.
    expect((event.request.headers as Record<string, string>)["user-agent"]).toBe("Safari");
    const browser = redactEvent({
      request: { headers: { "User-Agent": "Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36" } },
    });
    expect(browser.request.headers).toEqual({ "User-Agent": "Chrome" });
  });

  it("a User-Agent is reduced to one of six words", () => {
    const cases: Array<[string, string]> = [
      [
        "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
        "Edge",
      ],
      [
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36 OPR/120.0",
        "Opera",
      ],
      ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", "Firefox"],
      ["Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/141.0 Mobile/15E148 Safari/604.1", "Chrome"],
      ["Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15", "Safari"],
      ["curl/8.7.1", "other"],
      ["<script>alert(1)</script> ada@example.com 203.0.113.9", "other"],
      ["", "other"],
    ];
    for (const [userAgent, family] of cases) expect(userAgentFamily(userAgent), userAgent).toBe(family);
  });
});

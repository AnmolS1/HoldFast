// The redactor against the inputs of the security review (S2–S6, S9): each case is one the
// review ran against the previous version and saw a secret survive.
import { describe, expect, it } from "vitest";
import { REDACTION_FAILED, redactEvent, redactText } from "../../../src/shared/sentry-redact";

const TAIL = "TAILSECRET14";

describe("S2 — an encoded delimiter inside a named secret's value does not cut the value short", () => {
  it.each([
    [`token=abc%20${TAIL}`, "a percent-encoded space"],
    [`token=abc%2520${TAIL}`, "a twice-encoded space"],
    [`{"password":"pre&#10;${TAIL}"}`, "an entity newline in a JSON value"],
    [`password=pre%0a${TAIL}`, "a percent-encoded newline"],
    [`password=pre&#x20;${TAIL}`, "an entity space"],
    [`secret=pre\\u0020${TAIL}`, "an escaped space"],
    [`Cookie: a=1%0A${TAIL}`, "a header line with an encoded newline"],
    [`authorization: Token abc%0d%0a${TAIL}`, "a header line with an encoded CR LF"],
    [`{"password":"ab\\" ${TAIL} cd"}`, "an escaped quote followed by a space, in a JSON value"],
    [`Bearer abc%20${TAIL}`, "a bearer token with an encoded space"],
    [`api_key=%61bc%26x%3D${TAIL}`, "an encoded ampersand and equals sign"],
    // The name's own `=` and the delimiter inside the value in DIFFERENT encodings: whichever
    // is peeled first must not decide how much of the value is taken.
    [`secret\\u003dpre&#x20;${TAIL}`, "an escaped `=`, an entity space"],
    [`secret&#61;pre%20${TAIL}`, "an entity `=`, a percent space"],
    [`secret%3Dpre&amp;${TAIL}`, "a percent `=`, an entity ampersand"],
    [`secret&#61;pre&amp;&#35;x20;${TAIL}`, "the whole pair written in entities, over an entity"],
    [`Bearer%20abc%2520${TAIL}`, "a bearer token whose own space is encoded once and its inner space twice"],
    [
      `\\u007b\\u0022password\\u0022:\\u0022ab\\u005c\\u0022 ${TAIL} cd\\u0022\\u007d`,
      "a JSON pair in unicode escapes, with an escaped quote in the value",
    ],
  ])("%s (%s)", (input) => {
    const out = redactText(input);
    expect(out, out).not.toContain(TAIL);
    expect(out).not.toContain("TAILSECRET");
    expect(redactText(out)).toBe(out);
  });

  it("the same inside an event, and around other text", () => {
    const out = JSON.stringify(
      redactEvent({
        message: `sign-in failed: token=abc%20${TAIL} (retry)`,
        extra: { body: `{"password":"pre&#10;${TAIL}"}`, note: `password=correct%20horse%20${TAIL}` },
      }),
    );
    expect(out).not.toContain("TAILSECRET");
    expect(out).toContain("sign-in failed");
  });

  it("a pair whose name is not sensitive is still not swallowed", () => {
    expect(redactText("status=failed%20again reason=timeout")).toBe("status=failed again reason=timeout");
    expect(redactText("finish: x-api-key: abc%20def")).toBe("finish: x-api-key: [redacted]");
  });
});

describe("S3 — numbers, names everywhere, and header tuples", () => {
  it("a one-time code sent as a NUMBER is replaced, under any key and in any array", () => {
    const out = redactEvent({
      extra: { code: 482913, otp: 482913, pin: 4821, anything: 482913, list: [48291357, 12] },
      contexts: { app: { attempts: 3, verification: 9482913 } },
    }) as { extra: Record<string, unknown>; contexts: { app: Record<string, unknown> } };
    expect(JSON.stringify(out)).not.toMatch(/482913|4821\b|48291357/);
    // Small numbers are what makes an event readable: kept.
    expect(out.extra.list).toEqual(["[code]", 12]);
    expect(out.contexts.app.attempts).toBe(3);
  });

  it("a stack frame keeps its line and column, and a timestamp or a status stays a number", () => {
    const out = redactEvent({
      timestamp: 1_760_000_000,
      exception: {
        values: [{ stacktrace: { frames: [{ lineno: 123456, colno: 7654321, function: "run" }] } }],
      },
      contexts: { response: { status_code: 500 } },
      // The same key names anywhere else are scanned like any number.
      extra: { lineno: 123456 },
    });
    expect(out).toEqual({
      timestamp: 1_760_000_000,
      exception: {
        values: [{ stacktrace: { frames: [{ lineno: 123456, colno: 7654321, function: "run" }] } }],
      },
      contexts: { response: { status_code: 500 } },
      extra: { lineno: "[code]" },
    });
  });

  it("a sensitive name is sensitive wherever it is — not only under `request`", () => {
    const out = redactEvent({
      extra: {
        pwd: "hunter2hunter2",
        pass: "open sesame",
        auth: "abc",
        pin: "4821",
        otp: "654321",
        state: "f3a9c1d2e7b84a6f9c0d1e2f3a4b5c6d",
        backupCodes: ["abcde-fghij", "klmno-pqrst"],
        birthYear: 1990,
        birthMonth: 5,
        dob: "1990-05-01",
      },
      tags: { nonce: "n-0123", captcha: "tok" },
    }) as { extra: Record<string, unknown>; tags: Record<string, unknown> };
    for (const key of [
      "pwd",
      "pass",
      "auth",
      "pin",
      "otp",
      "state",
      "backupCodes",
      "birthYear",
      "birthMonth",
      "dob",
    ]) {
      expect(out.extra[key], key).toBe("[redacted]");
    }
    expect(out.tags).toEqual({ nonce: "[redacted]", captcha: "[redacted]" });
  });

  it("…while an error's own code and a record's own state stay readable", () => {
    const out = redactEvent({
      extra: { code: "23505", state: "open", status: "pending" },
      exception: { values: [{ mechanism: { data: { code: "ECONNRESET" } } }] },
      contexts: { response: { code: 500 }, job: { state: "IN_PROGRESS" } },
    });
    expect(out).toEqual({
      extra: { code: "23505", state: "open", status: "pending" },
      exception: { values: [{ mechanism: { data: { code: "ECONNRESET" } } }] },
      contexts: { response: { code: 500 }, job: { state: "IN_PROGRESS" } },
    });
    // The same names with something that is NOT a code or a plain word: gone.
    const secret = redactEvent({ extra: { code: "Zx9-Yw8-Vu7", state: "a1B2c3D4e5", code2: 1 } }) as {
      extra: Record<string, unknown>;
    };
    expect(secret.extra.code).toBe("[redacted]");
    expect(secret.extra.state).toBe("[redacted]");
  });

  it("the names the review found missing", () => {
    const out = redactEvent({
      request: {
        other: {
          pw: "a",
          newPass: "b",
          answer: "c",
          verifier: "d",
          codeVerifier: "short",
          nonce: "e",
          captcha: "f",
          key: "g",
          x_captcha_response: "h",
          "X_Captcha-Response": "i",
        },
      },
    }) as { request: { other: Record<string, unknown> } };
    expect(out.request.other).toEqual({
      pw: "[redacted]",
      newPass: "[redacted]",
      answer: "[redacted]",
      verifier: "[redacted]",
      codeVerifier: "[redacted]",
      nonce: "[redacted]",
      captcha: "[redacted]",
      key: "[redacted]",
      // The captcha header is dropped under any spelling of its separators.
    });
  });

  it("headers given as [name, value] tuples get the rules of their names", () => {
    const out = redactEvent({
      extra: {
        headers: [
          ["cookie", "sid=abc123"],
          ["Authorization", "Token zzz"],
          ["x-api-key", "k"],
          ["user-agent", "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"],
          ["accept", "text/html"],
          ["cf-connecting-ip", "203.0.113.9"],
        ],
        pairs: [["a", "b"]],
      },
    });
    expect(out).toEqual({
      extra: {
        headers: [
          ["x-api-key", "[redacted]"],
          ["user-agent", "Firefox"],
          ["accept", "text/html"],
        ],
        pairs: [["a", "b"]],
      },
    });
  });
});

describe("S4 — unicode", () => {
  it("an address with non-ASCII letters is an address", () => {
    expect(redactText("mail to jané@exämple.com failed")).toBe("mail to [email] failed");
    expect(redactText("jane@bücher.de")).toBe("[email]");
    expect(redactText("用户@例子.公司 was refused")).toBe("[email] was refused");
  });

  it("a sensitive name written with look-alike characters is the same name", () => {
    const out = redactEvent({
      extra: { ｐａｓｓｗｏｒｄ: "one", pаssword: "two", ΤΟΚΕΝ: "three", sеcrеt: "four" },
    }) as { extra: Record<string, unknown> };
    expect(Object.values(out.extra)).toEqual(["[redacted]", "[redacted]", "[redacted]", "[redacted]"]);
    expect(redactText("ｐａｓｓｗｏｒｄ=hunter2 pаssword: hunter3")).not.toMatch(/hunter/);
  });
});

describe("S5 — shapes", () => {
  it("a backup code without a digit, and one without a letter", () => {
    expect(redactText("your code is aBcDe-fGhIj now")).toBe("your code is [code] now");
    expect(redactText("code ABCDE-FGHIJ")).toBe("code [code]");
    expect(redactText("code 12345-67890")).toBe("code [code]");
    // Two lower-case words of five letters are words.
    expect(redactText("a known-issue with first-class seats")).toBe("a known-issue with first-class seats");
  });

  it("a token made of dot-joined pieces too short to be a long run each", () => {
    expect(redactText("got abc123XYZ.def456UVW.ghi789RST back")).toBe("got [token] back");
    // Not a token: a host name, a file name, a version.
    expect(redactText("see holdfast.ponderance.dev and index.worker.js at 1.22.333")).toBe(
      "see holdfast.ponderance.dev and index.worker.js at 1.22.333",
    );
  });

  it("a long run of letters in one case, with no separator, is not a word", () => {
    expect(redactText("key qwertyuiopasdfghjklzxcvbnmqwerty end")).toBe("key [token] end");
    expect(redactText("INVALID_EMAIL_OR_PASSWORD and set-user-password stay")).toBe(
      "INVALID_EMAIL_OR_PASSWORD and set-user-password stay",
    );
  });

  it("a token-bearing path written without its leading slash", () => {
    expect(redactText("opened invite/ABCD1234 twice")).toBe("opened invite/[redacted] twice");
    expect(redactText("api/public/links/AbCdEfGhIjKl")).toBe("api/public/links/[redacted]");
    expect(redactText("api/auth/reset-password/tok123?x=1 done")).toBe(
      "api/auth/reset-password/[redacted] done",
    );
  });
});

describe("S9 — the breach lookup's hash prefix", () => {
  it("is not kept in a URL or a breadcrumb", () => {
    expect(redactText("https://api.pwnedpasswords.com/range/5BAA6")).toBe(
      "https://api.pwnedpasswords.com/range/[redacted]",
    );
    expect(
      redactEvent({
        breadcrumbs: [{ category: "fetch", data: { url: "https://api.pwnedpasswords.com/range/5BAA6" } }],
      }),
    ).toEqual({
      breadcrumbs: [{ category: "fetch", data: { url: "https://api.pwnedpasswords.com/range/[redacted]" } }],
    });
  });
});

describe("S6 — the cost of redaction is bounded", () => {
  it("one long run of one character is scanned in linear time", () => {
    for (const filler of ["a", "a.", "a@", "/", "x-"]) {
      const text = filler.repeat(Math.ceil(4096 / filler.length));
      const started = performance.now();
      redactText(text);
      expect(performance.now() - started, filler).toBeLessThan(40);
    }
  });

  it("an event with hundreds of such strings does not burn seconds: it is redacted quickly or fails closed", () => {
    const hostile = "a".repeat(4096);
    const event = {
      message: "x",
      extra: {
        list: Array.from({ length: 400 }, () => hostile),
        more: Array.from({ length: 400 }, () => `${hostile}@`),
      },
    };
    let failures = 0;
    const started = performance.now();
    const out = redactEvent(event, () => {
      failures += 1;
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1500);
    // Past the per-event budget of characters: the marker, counted — never a slow success.
    expect(out).toEqual({ message: REDACTION_FAILED, level: "error" });
    expect(failures).toBe(1);
  });

  it("an ordinary large event is well inside the budget", () => {
    const event = {
      message: "request failed",
      breadcrumbs: Array.from({ length: 100 }, (_, index) => ({
        category: "fetch",
        data: { url: `https://app.example/api/nodes/${index}?x=1`, status_code: 200 },
        message: "GET /api/nodes — a perfectly ordinary breadcrumb message of moderate length",
      })),
    };
    let failures = 0;
    const out = redactEvent(event, () => {
      failures += 1;
    }) as { breadcrumbs: unknown[] };
    expect(failures).toBe(0);
    expect(out.breadcrumbs).toHaveLength(100);
  });
});

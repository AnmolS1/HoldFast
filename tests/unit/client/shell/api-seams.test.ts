// lib/api.ts, three seams the features asked for (T16, T17):
//  - a `429 ceiling_exceeded` is a daily limit, not "too many requests": its own toast, with the
//    time from `Retry-After` when there is one; a caller that says so itself passes `silent`.
//  - the envelope parser is exported (`toApiError` for a Response, `apiErrorOf` for an answer read
//    some other way — the upload bodies go through XMLHttpRequest).
//  - `empty: true`: an answer whose body the caller does not want (`202` with or without one).
import { describe, expect, it } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { api, ApiError, apiErrorOf, toApiError, toastApiError } from "../../../../src/client/lib/api";
import { envelope, json, mockFetch, setupShell } from "./helpers";

setupShell();

const toasts = () => getToasts().map((toast) => toast.message);

describe("429 ceiling_exceeded", () => {
  it.each([
    ["30", "Daily limit reached. It resets in 30 s."],
    ["2700", "Daily limit reached. It resets in 45 min."],
    ["5400", "Daily limit reached. It resets in 1 h 30 min."],
    ["7200", "Daily limit reached. It resets in 2 h."],
  ])("Retry-After %s → %s (never the rate-limit sentence)", async (header, sentence) => {
    mockFetch(() => envelope("ceiling_exceeded", 429, { kind: "share_user" }, { "retry-after": header }));
    await expect(api("/api/shares", { method: "POST" })).rejects.toMatchObject({
      status: 429,
      code: "ceiling_exceeded",
      retryAfter: Number(header),
    });
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0]).toMatchObject({ message: sentence, requestId: "req-1234" });
  });

  it("without Retry-After: when it resets, in words", async () => {
    mockFetch(() => envelope("ceiling_exceeded", 429, { kind: "share_user" }));
    await expect(api("/api/shares", { method: "POST" })).rejects.toBeInstanceOf(ApiError);
    expect(toasts()).toEqual(["Daily limit reached. It resets at midnight UTC."]);
  });

  it("silent: the caller says it itself — no toast, the same error", async () => {
    mockFetch(() => envelope("ceiling_exceeded", 429, { kind: "upload_user" }, { "retry-after": "60" }));
    await expect(api("/api/uploads", { method: "POST", silent: ["ceiling_exceeded"] })).rejects.toMatchObject(
      { code: "ceiling_exceeded", retryAfter: 60 },
    );
    expect(toasts()).toEqual([]);
  });

  it("silent names codes, not statuses: a rate_limited 429 on the same call still has its toast", async () => {
    mockFetch(() => envelope("rate_limited", 429, undefined, { "retry-after": "5" }));
    await expect(api("/api/uploads", { method: "POST", silent: ["ceiling_exceeded"] })).rejects.toMatchObject(
      {
        code: "rate_limited",
      },
    );
    expect(toasts()).toEqual(["Too many requests. Try again in 5 s."]);
  });

  it("toastApiError adds nothing to an announced 429", () => {
    toastApiError(new ApiError({ status: 429, code: "ceiling_exceeded", message: "x", retryAfter: 9 }));
    expect(toasts()).toEqual([]);
  });
});

describe("the exported parsers", () => {
  const body = { error: "conflict", message: "Taken.", requestId: "req-9", details: { existingId: "n1" } };

  it("toApiError reads a Response; apiErrorOf the same answer from its parts — the same error", async () => {
    const response = json(body, 409, { "retry-after": "12" });
    const fromResponse = await toApiError(response);
    const fromParts = apiErrorOf({ status: 409, body: JSON.stringify(body), retryAfter: "12" });
    for (const error of [fromResponse, fromParts]) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status: 409,
        code: "conflict",
        message: "Taken.",
        requestId: "req-9",
        details: { existingId: "n1" },
        retryAfter: 12,
      });
    }
  });

  it("apiErrorOf: no envelope → http_error with the caller's fallback words; an unknown code is not trusted", () => {
    expect(apiErrorOf({ status: 502, body: "<html>", retryAfter: null }, "Upload failed")).toMatchObject({
      status: 502,
      code: "http_error",
      message: "Upload failed",
    });
    expect(
      apiErrorOf({
        status: 500,
        body: JSON.stringify({ error: "internal", message: "stack…", requestId: "r" }),
      }),
    ).toMatchObject({ code: "internal", requestId: "r", message: "Something went wrong. Try again." });
    expect(
      apiErrorOf({ status: 418, body: JSON.stringify({ error: "teapot_new", message: "server words" }) }),
    ).toMatchObject({ code: "http_error" });
  });
});

describe("empty: true", () => {
  it.each([
    ["202 with no body", () => new Response(null, { status: 202 })],
    ["202 with a body", () => json({ ok: true }, 202)],
    ["200 with a body that is not JSON", () => new Response("accepted", { status: 200 })],
  ])("%s resolves to undefined, nothing parsed", async (_name, answer) => {
    mockFetch(() => answer());
    await expect(api("/api/nodes/n1/rescan", { method: "POST", empty: true })).resolves.toBeUndefined();
  });

  it("a failure is still a failure", async () => {
    mockFetch(() => envelope("rate_limited", 429, undefined, { "retry-after": "3" }));
    await expect(api("/api/nodes/n1/rescan", { method: "POST", empty: true })).rejects.toMatchObject({
      status: 429,
    });
  });

  it("control: without it, a 202 with no body is invalid_response", async () => {
    mockFetch(() => new Response(null, { status: 202 }));
    await expect(api("/api/nodes/n1/rescan", { method: "POST" })).rejects.toMatchObject({
      code: "invalid_response",
      status: 202,
    });
  });
});

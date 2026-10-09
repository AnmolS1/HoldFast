// The 401 rule and the rest of the API client's status handling.
import { beforeEach, describe, expect, it } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import {
  api,
  ApiError,
  AUTH_EXPIRED_EVENT,
  cancelReauth,
  completeReauth,
  configureApi,
  isReauthPending,
  shouldReauth,
  type ReauthInput,
  type RouteInfo,
} from "../../../../src/client/lib/api";
import { PublicConfig } from "../../../../src/client/lib/contracts";
import { publicConfigQuery, queryClient } from "../../../../src/client/lib/query";
import { envelope, flush, json, mockFetch, seedConfig, seedSession, sessionOf, setupShell } from "./helpers";

setupShell();

const APP: RouteInfo = { public: false, auth: false };
const base: ReauthInput = {
  status: 401,
  code: "unauthorized",
  path: "/api/nodes",
  hadSession: true,
  route: APP,
};

describe("shouldReauth (pure)", () => {
  const table: Array<[string, Partial<ReauthInput>, boolean]> = [
    ["signed-in app route, 401 unauthorized on /api/nodes", {}, true],
    ["an absolute URL to the same kind of path", { path: "http://localhost:3000/api/nodes/1?x=1" }, true],
    ["/api/public/* never", { path: "/api/public/links/tok/info" }, false],
    [
      "/api/auth/* never (a wrong password, any Better Auth answer)",
      { path: "/api/auth/sign-in/email" },
      false,
    ],
    ["/api/auth-intent is not under /api/auth/ and does qualify", { path: "/api/auth-intent" }, true],
    ["a path outside /api/", { path: "/s/token" }, false],
    ["no session when the request was made", { hadSession: false }, false],
    ["a public route (handle.public)", { route: { public: true, auth: false } }, false],
    ["an auth screen", { route: { public: false, auth: true } }, false],
    ["403 password_required", { status: 403, code: "password_required" }, false],
    ["a 401 with another code", { code: "forbidden" }, false],
    ["a 401 with no envelope", { code: undefined }, false],
    ["a 403 unauthorized-coded oddity", { status: 403 }, false],
  ];
  it.each(table)("%s → %s", (_name, patch, expected) => {
    expect(shouldReauth({ ...base, ...patch })).toBe(expected);
  });
});

describe("401 through api()", () => {
  let route: RouteInfo;
  beforeEach(() => {
    route = { ...APP };
    configureApi({ routeInfo: () => route });
  });

  it("signed-in app route → the modal opens, auth:expired fires, and the request replays after re-auth", async () => {
    seedSession(sessionOf());
    let expired = 0;
    const onExpired = () => (expired += 1);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    let signedIn = false;
    const calls = mockFetch((call) =>
      call.path === "/api/nodes"
        ? signedIn
          ? json({ ok: true })
          : envelope("unauthorized", 401)
        : undefined,
    );

    const pending = api<{ ok: boolean }>("/api/nodes", { method: "POST", body: { name: "x" } });
    await flush();
    expect(isReauthPending()).toBe(true);
    expect(expired).toBe(1);
    expect(calls.length).toBe(1);

    signedIn = true;
    completeReauth();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(isReauthPending()).toBe(false);
    // The replay is the same request: method and body intact.
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/api/nodes", { name: "x" }],
      ["POST", "/api/nodes", { name: "x" }],
    ]);
    window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  });

  it("two concurrent 401s → one modal, both replay", async () => {
    seedSession(sessionOf());
    let expired = 0;
    const onExpired = () => (expired += 1);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    let signedIn = false;
    mockFetch((call) => (signedIn ? json({ path: call.path }) : envelope("unauthorized", 401)));
    const a = api("/api/nodes/a");
    const b = api("/api/nodes/b");
    await flush();
    expect(expired).toBe(1);
    signedIn = true;
    completeReauth();
    await expect(Promise.all([a, b])).resolves.toEqual([{ path: "/api/nodes/a" }, { path: "/api/nodes/b" }]);
    window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  });

  it("cancelling rejects every held request with its 401", async () => {
    seedSession(sessionOf());
    mockFetch(() => envelope("unauthorized", 401));
    const a = api("/api/nodes/a");
    const b = api("/api/nodes/b");
    await flush();
    cancelReauth();
    await expect(a).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    await expect(b).rejects.toMatchObject({ status: 401 });
    expect(isReauthPending()).toBe(false);
  });

  it("a replay that is refused again is an error, not a second modal", async () => {
    seedSession(sessionOf());
    const calls = mockFetch(() => envelope("unauthorized", 401));
    const pending = api("/api/nodes");
    await flush();
    completeReauth();
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(calls.length).toBe(2);
    expect(isReauthPending()).toBe(false);
  });

  const noModal: Array<[string, () => void, string, Response]> = [
    [
      "/api/public/* 401",
      () => seedSession(sessionOf()),
      "/api/public/links/t/info",
      envelope("unauthorized", 401),
    ],
    [
      "/api/auth/* 401",
      () => seedSession(sessionOf()),
      "/api/auth/sign-in/email",
      envelope("unauthorized", 401),
    ],
    [
      "any 401 on a handle.public route",
      () => {
        seedSession(sessionOf());
        route = { public: true, auth: false };
      },
      "/api/nodes",
      envelope("unauthorized", 401),
    ],
    [
      "any 401 on an auth screen",
      () => {
        seedSession(sessionOf());
        route = { public: false, auth: true };
      },
      "/api/nodes",
      envelope("unauthorized", 401),
    ],
    [
      "a 401 with no session at request time",
      () => seedSession(null),
      "/api/nodes",
      envelope("unauthorized", 401),
    ],
    [
      "403 password_required",
      () => seedSession(sessionOf()),
      "/api/public/links/t/download-url",
      envelope("password_required", 403),
    ],
    [
      "403 password_required even on an app path",
      () => seedSession(sessionOf()),
      "/api/nodes",
      envelope("password_required", 403),
    ],
  ];
  it.each(noModal)("%s → no modal", async (_name, arrange, path, response) => {
    arrange();
    let expired = 0;
    const onExpired = () => (expired += 1);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    const calls = mockFetch(() => response.clone());
    await expect(api(path)).rejects.toBeInstanceOf(ApiError);
    expect(isReauthPending()).toBe(false);
    expect(expired).toBe(0);
    expect(calls.length).toBe(1);
    window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  });

  it("the session is captured when the request STARTS: one that ends mid-flight still counts", async () => {
    seedSession(sessionOf());
    mockFetch(async () => {
      seedSession(null);
      return envelope("unauthorized", 401);
    });
    const pending = api("/api/nodes");
    await flush();
    expect(isReauthPending()).toBe(true);
    cancelReauth();
    await expect(pending).rejects.toBeInstanceOf(ApiError);
  });
});

describe("other statuses", () => {
  let navigated: string[];
  beforeEach(() => {
    navigated = [];
    configureApi({ routeInfo: () => APP, navigate: (to) => void navigated.push(to) });
    seedSession(sessionOf());
    seedConfig();
  });

  it("the envelope becomes a typed ApiError with the request id", async () => {
    mockFetch(() => envelope("conflict", 409, { name: "taken" }));
    const error = await api("/api/nodes").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "conflict",
      message: "conflict message",
      requestId: "req-1234",
      details: { name: "taken" },
    });
  });

  it("403 account_suspended → signed out locally and sent to /login?reason=suspended", async () => {
    mockFetch(() => envelope("forbidden", 403, { reason: "account_suspended" }));
    await expect(api("/api/nodes")).rejects.toMatchObject({ status: 403 });
    expect(navigated).toEqual(["/login?reason=suspended"]);
    expect(queryClient.getQueryData(["session"])).toBeNull();
  });

  it("403 impersonation_read_only → a toast", async () => {
    mockFetch(() => envelope("forbidden", 403, { reason: "impersonation_read_only" }));
    await expect(api("/api/nodes", { method: "POST" })).rejects.toMatchObject({ status: 403 });
    expect(getToasts().map((toast) => toast.message)).toEqual(["Read-only while impersonating"]);
    expect(navigated).toEqual([]);
  });

  it("429 → a toast with Retry-After", async () => {
    mockFetch(() => envelope("rate_limited", 429, undefined, { "retry-after": "42" }));
    await expect(api("/api/nodes")).rejects.toMatchObject({ status: 429, retryAfter: 42 });
    expect(getToasts()[0]).toMatchObject({
      message: "Too many requests. Try again in 42 s.",
      requestId: "req-1234",
    });
  });

  it("503 read_only → the config flips to read-only (the banner), plus a toast", async () => {
    mockFetch(() => envelope("read_only", 503));
    await expect(api("/api/nodes", { method: "POST" })).rejects.toMatchObject({ status: 503 });
    expect(queryClient.getQueryData(publicConfigQuery.queryKey)?.readOnly).toBe(true);
    expect(getToasts()[0]?.message).toBe("Holdfast is read-only for maintenance.");
  });

  it.each([
    ["uploads_disabled", "Uploads are paused right now.", "uploadsEnabled"],
    ["links_disabled", "Link sharing is paused right now.", "linksEnabled"],
  ] as const)(
    "503 feature_disabled %s → the toast names the feature and the control's flag flips",
    async (reason, message, flag) => {
      mockFetch(() => envelope("feature_disabled", 503, { reason }));
      await expect(api("/api/uploads", { method: "POST" })).rejects.toMatchObject({ status: 503 });
      expect(getToasts()[0]?.message).toBe(message);
      expect(queryClient.getQueryData(publicConfigQuery.queryKey)?.[flag]).toBe(false);
    },
  );

  it("an HTML answer where JSON was expected is an invalid_response error, not a crash", async () => {
    mockFetch(
      () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    await expect(api("/api/public/config", { schema: PublicConfig })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("sends same-origin credentials and JSON", async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return json({});
    }) as typeof fetch;
    await api("/api/nodes", { method: "POST", body: { a: 1 } });
    expect(seen?.credentials).toBe("same-origin");
    expect(seen?.body).toBe('{"a":1}');
    expect((seen?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });
});

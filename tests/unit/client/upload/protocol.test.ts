// The body transport on XMLHttpRequest: what it sends, how it reports progress, and that every
// failure comes back as the API client's own error type.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PartResponse } from "../../../../src/shared/schemas/upload";
import { putBody } from "../../../../src/client/features/upload/protocol";
import { ApiError, configureApi, IDENTITY_HEADER, resetApiForTests } from "../../../../src/client/lib/api";
import { errorBody } from "./fixtures";

class FakeXhr {
  static made: FakeXhr[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  responseText = "";
  responseType = "";
  responseHeaders: Record<string, string> = {};
  upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;
  constructor() {
    FakeXhr.made.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  getResponseHeader(name: string) {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  answer(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.responseHeaders = headers;
    this.onload?.();
  }
}

beforeEach(() => {
  FakeXhr.made = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => vi.unstubAllGlobals());

const blob = new Blob(["0123456789"]);
const path = "/api/uploads/0199d3c2-7a10-7000-8000-0000000000b1/parts/2";
const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (cause: unknown) => cause as ApiError,
  );

describe("putBody", () => {
  it("a body refused as another account's (identity_mismatch) starts the adoption, once", async () => {
    const identityChanged = vi.fn(async () => {});
    const navigated: string[] = [];
    // Sent for A, and the tab still holds A: the browser's session is another account — adopt it.
    configureApi({
      userId: () => "a".repeat(32),
      identityChanged,
      navigate: (to) => void navigated.push(to),
    });
    try {
      const promise = caught(putBody(path, blob, PartResponse));
      FakeXhr.made[0]!.answer(403, {
        error: "forbidden",
        message: "x",
        requestId: "r",
        details: { reason: "identity_mismatch" },
      });
      expect(await promise).toMatchObject({ status: 403, details: { reason: "identity_mismatch" } });
      await vi.waitFor(() => expect(navigated).toEqual(["/"]));
      expect(identityChanged).toHaveBeenCalledTimes(1);
    } finally {
      resetApiForTests();
    }
  });

  // Review m4: the account is the one the upload was started for, not whoever is known when a
  // body leaves.
  it("an upload started for A names A on every body, whoever the tab knows by then", async () => {
    configureApi({ userId: () => "b".repeat(32) });
    try {
      const promise = putBody(path, blob, PartResponse, { account: "a".repeat(32) });
      expect(FakeXhr.made[0]!.headers[IDENTITY_HEADER]).toBe("a".repeat(32));
      FakeXhr.made[0]!.answer(200, { n: 2, etag: "abc" });
      await promise;
    } finally {
      resetApiForTests();
    }
  });

  // Review M1 on the XHR path: a body sent for A and refused after the tab moved to B adopts nothing.
  it("a body refused after the tab moved to another account: no adoption", async () => {
    const identityChanged = vi.fn(async () => {});
    const navigated: string[] = [];
    configureApi({
      userId: () => "b".repeat(32),
      identityChanged,
      navigate: (to) => void navigated.push(to),
    });
    try {
      const promise = caught(putBody(path, blob, PartResponse, { account: "a".repeat(32) }));
      FakeXhr.made[0]!.answer(403, {
        error: "forbidden",
        message: "x",
        requestId: "r",
        details: { reason: "identity_mismatch" },
      });
      expect(await promise).toMatchObject({ status: 403 });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(identityChanged).not.toHaveBeenCalled();
      expect(navigated).toEqual([]);
    } finally {
      resetApiForTests();
    }
  });

  it("names the account the upload is for (the identity pin), when one is known", async () => {
    configureApi({ userId: () => "a".repeat(32) });
    try {
      const promise = putBody(path, blob, PartResponse);
      expect(FakeXhr.made[0]!.headers[IDENTITY_HEADER]).toBe("a".repeat(32));
      FakeXhr.made[0]!.answer(200, { n: 2, etag: "abc" });
      await promise;
    } finally {
      resetApiForTests();
    }
  });

  it("sends the blob itself with PUT — a body of known length, never a stream", async () => {
    const promise = putBody(path, blob, PartResponse);
    const [xhr] = FakeXhr.made;
    expect(xhr!.method).toBe("PUT");
    expect(xhr!.url).toBe(path);
    expect(xhr!.body).toBe(blob);
    expect(xhr!.headers).toEqual({ accept: "application/json", "content-type": "application/octet-stream" });
    // Content-Length is the browser's to set, from the blob's size.
    expect(Object.keys(xhr!.headers)).not.toContain("content-length");
    expect(Object.keys(xhr!.headers)).not.toContain("transfer-encoding");
    xhr!.answer(200, { n: 2, etag: "abc" });
    expect(await promise).toEqual({ n: 2, etag: "abc" });
  });

  it("reports the bytes sent so far", async () => {
    const seen: number[] = [];
    const promise = putBody(path, blob, PartResponse, { onProgress: (loaded) => seen.push(loaded) });
    const [xhr] = FakeXhr.made;
    xhr!.upload.onprogress?.({ loaded: 4 });
    xhr!.upload.onprogress?.({ loaded: 10 });
    xhr!.answer(200, { n: 2, etag: "abc" });
    await promise;
    expect(seen).toEqual([4, 10]);
  });

  it("an error envelope becomes the same ApiError the API client throws", async () => {
    const promise = caught(putBody(path, blob, PartResponse));
    FakeXhr.made[0]!.answer(
      429,
      errorBody("ceiling_exceeded", "Daily limit reached.", { kind: "upload_user" }),
      { "retry-after": "120" },
    );
    const error = await promise;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 429,
      code: "ceiling_exceeded",
      message: "Daily limit reached.",
      requestId: "req-upload",
      details: { kind: "upload_user" },
      retryAfter: 120,
    });
  });

  it.each([
    ["the 500 envelope", 500, { error: "internal", message: "boom", requestId: "r1" }, "internal", "r1"],
    [
      "a code this build does not know",
      418,
      { error: "teapot", message: "x", requestId: "r2" },
      "http_error",
      "r2",
    ],
    ["no envelope at all", 502, "<html>bad gateway</html>", "http_error", undefined],
  ])("%s is a generic failure in our own words", async (_name, status, body, code, requestId) => {
    const promise = caught(putBody(path, blob, PartResponse));
    FakeXhr.made[0]!.answer(status, body);
    const error = await promise;
    expect(error).toMatchObject({ status, code, requestId, message: "Didn't finish. Try again." });
  });

  it("a 2xx that is not the contract's shape is invalid_response", async () => {
    const promise = caught(putBody(path, blob, PartResponse));
    FakeXhr.made[0]!.answer(200, { part: 2 });
    expect(await promise).toMatchObject({ status: 200, code: "invalid_response" });
  });

  it("no answer is a network error with status 0", async () => {
    const promise = caught(putBody(path, blob, PartResponse));
    FakeXhr.made[0]!.onerror?.();
    expect(await promise).toMatchObject({ status: 0, code: "network" });
  });

  it("aborting the signal aborts the request and rejects with AbortError", async () => {
    const controller = new AbortController();
    const promise = caught(putBody(path, blob, PartResponse, { signal: controller.signal }));
    controller.abort();
    const error = (await promise) as unknown as DOMException;
    expect(FakeXhr.made[0]!.aborted).toBe(true);
    expect(error).toBeInstanceOf(DOMException);
    expect(error.name).toBe("AbortError");
  });

  it("a signal that is already aborted sends nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = (await caught(
      putBody(path, blob, PartResponse, { signal: controller.signal }),
    )) as unknown as DOMException;
    expect(error.name).toBe("AbortError");
    expect(FakeXhr.made).toEqual([]);
  });
});

// What the BROWSER SDK collects, with the app's own options — the real `@sentry/react`, a
// transport that records instead of sending.
//
// @sentry/browser 11.5 (build/npm/esm/prod/client.js): with `dataCollection.userInfo` on (the
// default) the SDK asks Sentry to infer the client's IP address from the connection
// (`sdk.settings.infer_ip: "auto"`) and adds it to session envelopes — something `beforeSend`
// never sees and so cannot remove. The app switches every category of collected data off.
import { afterAll, describe, expect, it, vi } from "vitest";
import { initSentry, resetSentryForTests } from "../../../../src/client/lib/sentry";

const sent: string[] = [];
const realFetch = globalThis.fetch;

describe("the browser SDK with the app's options", () => {
  afterAll(() => {
    vi.stubGlobal("fetch", realFetch);
  });

  it("collects no user info, cookies, headers, bodies or query strings; no replay; never asks for the IP", async () => {
    // Nothing may reach the network from a unit test, whatever the SDK decides to send.
    const network = vi.fn(async (...args: unknown[]) => (void args, new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", network);
    resetSentryForTests();
    const real = await import("@sentry/react");
    const transport = () =>
      real.createTransport({ recordDroppedEvent: () => {} }, async (request) => {
        sent.push(typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body));
        return { statusCode: 200 };
      });
    let passed: Record<string, unknown> | undefined;
    const started = await initSentry(
      {
        sentryDsnWeb: "https://public@o0.ingest.sentry.example.test/1",
        sentryEnvironment: "test",
        release: "abc",
      },
      async () =>
        ({
          ...real,
          init: (options: Record<string, unknown>) => {
            passed = options;
            return real.init({ ...options, transport } as Parameters<typeof real.init>[0]);
          },
        }) as typeof real,
    );
    expect(started).toBe(true);
    expect(passed?.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    });

    const client = real.getClient()!;
    expect(client.getDataCollectionOptions()).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
    });
    // S12: Relay is told never to infer the address.
    expect(client.getOptions()._metadata?.sdk?.settings).toMatchObject({ infer_ip: "never" });
    // No session replay, no HTTP-client body capture, no feedback widget: only the defaults.
    const names = (client.getOptions().integrations as Array<{ name: string }>).map((i) => i.name);
    expect(names.filter((name) => /replay|httpclient|feedback|canvas/i.test(name))).toEqual([]);

    // An event after a fetch to an API route: the breadcrumb has no body and no query.
    await fetch("/api/auth/sign-in/email?token=zzquerytoken", {
      method: "POST",
      body: JSON.stringify({ email: "jane.zz@mail.example", password: "zz horse staple" }),
    });
    real.captureException(new Error("after a sign-in call"));
    await client.flush(2000);
    const wire = sent.join("\n");
    expect(wire).toContain("after a sign-in call");
    expect(wire).toContain("/api/auth/sign-in/email");
    for (const needle of ["zzquerytoken", "zz horse staple", "jane.zz", "ip_address", '"infer_ip":"auto"']) {
      expect(wire, needle).not.toContain(needle);
    }
    expect(network.mock.calls.every(([url]) => String(url).startsWith("/api/"))).toBe(true);
    await client.close(100);
  });

  it("keeps no click or key-press crumbs: a file name in an element's label never reaches Sentry (R1 legal-7)", async () => {
    resetSentryForTests();
    sent.length = 0;
    const real = await import("@sentry/react");
    const transport = () =>
      real.createTransport({ recordDroppedEvent: () => {} }, async (request) => {
        sent.push(typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body));
        return { statusCode: 200 };
      });
    await initSentry(
      { sentryDsnWeb: "https://public@o0.ingest.sentry.example.test/1", sentryEnvironment: "test", release: "abc" },
      async () =>
        ({
          ...real,
          init: (options: Record<string, unknown>) =>
            real.init({ ...options, transport } as Parameters<typeof real.init>[0]),
        }) as typeof real,
    );
    const client = real.getClient()!;
    // Labels built from file names, as the upload panel and the previews build them (made-up names).
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Select zz divorce settlement draft.pdf");
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Rename zz therapy session notes.m4a");
    document.body.append(button, input);
    button.click();
    input.dispatchEvent(new KeyboardEvent("keypress", { key: "a", bubbles: true }));
    // The control: a crumb that is not a DOM one still travels.
    real.addBreadcrumb({ category: "navigation", message: "zz-control crumb" });
    real.captureException(new Error("after a click"));
    await client.flush(2000);
    const wire = sent.join("\n");
    expect(wire).toContain("after a click");
    expect(wire).toContain("zz-control crumb");
    expect(wire).not.toContain("ui.click");
    expect(wire).not.toContain("ui.input");
    for (const needle of ["divorce settlement", "therapy session"]) expect(wire, needle).not.toContain(needle);
    button.remove();
    input.remove();
    await client.close(100);
  });
});

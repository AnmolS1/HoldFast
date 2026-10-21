// Client storage (T26 item 19 (b), (c)): the latent Web Storage writes the Gate-A bundle scan's
// site count would not catch.
//   (b) React Router persists the pathnames of every navigation made WITH a view transition to
//       sessionStorage ("remix-router-transitions") on pagehide — /invite/:code and /s/:token carry
//       a secret in the path. So no navigation in the client uses `viewTransition`; and Sentry
//       Replay, which would make its own storage site live, is not set up.
//   (c) Better Auth's client posts a "session changed" note to localStorage ("better-auth.message")
//       after a sign-out or a session update, unless its broadcast channel is replaced — which
//       lib/auth-client.ts does (Symbol.for("better-auth:broadcast-channel")). A Better Auth upgrade
//       that renamed the symbol would silently bring the write back: this test catches it.
import { act } from "@testing-library/react";
import { getGlobalBroadcastChannel, kBroadcastChannel } from "better-auth/client";
import { createBrowserRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { betterAuthClient } from "../../../../src/client/lib/auth-client";
import { initSentry } from "../../../../src/client/lib/sentry";
import { buildRoutes } from "../../../../src/client/router";
import { json, setupShell, shellFetch } from "../shell/helpers";

setupShell();

const TRANSITIONS_KEY = "remix-router-transitions";
const SOURCES = import.meta.glob("../../../../src/client/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const pagehide = () => window.dispatchEvent(new Event("pagehide"));

describe("(b) no pathname with a secret in it is persisted by a view transition", () => {
  it("no navigation in the client source asks for a view transition", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    const offenders = Object.entries(SOURCES)
      .filter(([, source]) => /viewTransition/.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("the mechanism: a navigation WITH a view transition writes its pathnames on pagehide; one without writes nothing", async () => {
    const routes = [
      { path: "/", element: null },
      { path: "/invite/:code", element: null },
    ];
    window.history.replaceState(null, "", "/");
    const plain = createBrowserRouter(routes);
    await act(() => plain.navigate("/invite/PLAIN-SECRET-CODE"));
    pagehide();
    expect(sessionStorage.getItem(TRANSITIONS_KEY)).toBeNull();
    plain.dispose();

    window.history.replaceState(null, "", "/");
    const transitioned = createBrowserRouter(routes);
    await act(() => transitioned.navigate("/invite/TRANSITION-SECRET-CODE", { viewTransition: true }));
    pagehide();
    expect(sessionStorage.getItem(TRANSITIONS_KEY)).toContain("/invite/TRANSITION-SECRET-CODE");
    transitioned.dispose();
    sessionStorage.clear();
  });

  it("the app's own routes: visiting /invite/:code and /s/:token leaves no pathname in Web Storage", async () => {
    shellFetch({ extra: (call) => (call.path.startsWith("/api/") ? json(null) : undefined) });
    window.history.replaceState(null, "", "/login");
    const router = createBrowserRouter(buildRoutes());
    for (const path of ["/invite/APP-INVITE-SECRET", "/s/APPLINKTOKEN0123456789", "/login"]) {
      await act(() => router.navigate(path));
    }
    pagehide();
    for (const storage of [sessionStorage, localStorage]) {
      for (let i = 0; i < storage.length; i++) {
        const value = storage.getItem(storage.key(i)!) ?? "";
        expect(value).not.toContain("APP-INVITE-SECRET");
        expect(value).not.toContain("APPLINKTOKEN0123456789");
      }
    }
    expect(sessionStorage.getItem(TRANSITIONS_KEY)).toBeNull();
    router.dispose();
  });

  it("the client Sentry setup has no Replay integration", async () => {
    const options: Array<Record<string, unknown>> = [];
    const module = {
      init: (given: Record<string, unknown>) => void options.push(given),
      captureException: () => undefined,
    };
    const started = await initSentry(
      {
        sentryDsnWeb: "https://publickey@o1.ingest.sentry.example.test/1",
        sentryEnvironment: "test",
        release: "x",
      },
      async () => module as never,
    );
    expect(started).toBe(true);
    expect(options).toHaveLength(1);
    const [given] = options;
    expect(given!.integrations).toBeUndefined();
    expect(Object.keys(given!).filter((key) => /replay/i.test(key))).toEqual([]);
    // And nowhere in the client source.
    const offenders = Object.entries(SOURCES)
      .filter(([, source]) =>
        /replayIntegration|replaysSessionSampleRate|replaysOnErrorSampleRate/.test(source),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

describe("(c) Better Auth's cross-tab note is never written", () => {
  // The library posts through `getGlobalBroadcastChannel()` (better-auth/client, broadcast-channel)
  // after a sign-out or a session update. Asserted on the channel itself: in jsdom the client's
  // own sign-out does not reach the post, so a sign-out here would prove nothing.
  it("the library's channel is the silent one lib/auth-client.ts installed, under the symbol the library reads", () => {
    expect(betterAuthClient).toBeTruthy();
    expect(kBroadcastChannel).toBe(Symbol.for("better-auth:broadcast-channel"));
    const channel = getGlobalBroadcastChannel();
    expect(channel.constructor.name).not.toBe("WindowBroadcastChannel");
  });

  it("nothing in localStorage under better-auth.message after the notes a sign-out and a session update post", () => {
    const channel = getGlobalBroadcastChannel();
    channel.post({ event: "session", data: { trigger: "signout" }, clientId: "test" });
    channel.post({ event: "session", data: { trigger: "updateUser" }, clientId: "test" });
    expect(localStorage.getItem("better-auth.message")).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});

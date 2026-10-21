// History state across an account change (lib/history-state.ts): what a page of the frame writes
// carries the account; the frame never reads another account's state — not for one render.
import { act, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { useParams, type RouteObject } from "react-router";
import { describe, expect, it } from "vitest";
import type { SessionShape } from "../../../../src/client/lib/contracts";
import { ownHistoryState, stamped } from "../../../../src/client/lib/history-state";
import { adoptIdentity, getKnownUserId, queryClient, refreshSession } from "../../../../src/client/lib/query";
import { Frame } from "../../../../src/client/routes/frame/Frame";
import { renderRoutes, seedConfig, sessionOf, setupShell, shellFetch } from "./helpers";

setupShell();

const ALICE = sessionOf({ id: "a".repeat(32), name: "Alice", email: "alice@example.com" });
const BOB = sessionOf({ id: "b".repeat(32), name: "Bob", email: "bob@example.com" });

/** Every folder id a list page was ever drawn for, render by render. */
let drawn: string[] = [];

function ListPage() {
  const { id = "" } = useParams();
  drawn.push(id);
  useEffect(() => {}, []);
  return <div data-testid="list">folder={id}</div>;
}

const children: RouteObject[] = [
  { index: true, element: <div data-testid="root-page">root page</div>, handle: { title: "Files" } },
  { path: "folder/:id", element: <ListPage />, handle: { title: "Folder" } },
  { path: "preview/:nodeId", element: <div data-testid="preview">preview</div>, handle: { overlay: true } },
];
const background = children.filter((route) => !(route.handle as { overlay?: boolean }).overlay);
const routes: RouteObject[] = [{ path: "/", element: <Frame backgroundRoutes={background} />, children }];

async function signedInAs(session: NonNullable<SessionShape>, current: { session: SessionShape }) {
  current.session = session;
  queryClient.setQueryData(["session"], session);
  await act(async () => void (await adoptIdentity(session)));
}

describe("lib/history-state", () => {
  it("stamped() adds the signed-in account; ownHistoryState() refuses another account's, keeps unstamped", async () => {
    const current = { session: ALICE as SessionShape };
    shellFetch({ session: () => current.session });
    await signedInAs(ALICE, current);
    expect(stamped({ from: "/folder/1" })).toEqual({ from: "/folder/1", account: ALICE.user.id });
    expect(ownHistoryState({ from: "/x", account: ALICE.user.id })).toEqual({
      from: "/x",
      account: ALICE.user.id,
    });
    expect(ownHistoryState({ from: "/x", account: BOB.user.id })).toBeNull();
    expect(ownHistoryState({ from: "/x", account: 7 })).toBeNull();
    expect(ownHistoryState({ email: "typed@example.com" })).toEqual({ email: "typed@example.com" });
    expect(ownHistoryState(null)).toBeNull();
  });

  it("a cold preview entry stamped for another account: the frame draws the root underneath, never that account's folder", async () => {
    drawn = [];
    const current = { session: BOB as SessionShape };
    shellFetch({ session: () => current.session });
    seedConfig();
    await signedInAs(BOB, current);
    renderRoutes(routes, [
      { pathname: "/preview/node-3", state: { from: "/folder/alices-folder", account: ALICE.user.id } },
    ]);
    await screen.findByTestId("preview");
    expect(screen.getByTestId("root-page")).toBeTruthy();
    expect(drawn).toEqual([]);
  });

  it("the account changes while that entry is open (a re-read names B): not one render of A's folder after it", async () => {
    drawn = [];
    const current = { session: ALICE as SessionShape };
    shellFetch({ session: () => current.session });
    seedConfig();
    await signedInAs(ALICE, current);
    renderRoutes(routes, [
      { pathname: "/preview/node-3", state: stamped({ from: "/folder/alices-folder" }) },
    ]);
    await screen.findByTestId("preview");
    // A's own entry, read by A: A's folder underneath.
    expect(screen.getByTestId("list").textContent).toBe("folder=alices-folder");
    const before = drawn.length;

    current.session = BOB;
    await act(async () => void (await refreshSession()));
    await waitFor(() => expect(getKnownUserId()).toBe(BOB.user.id));
    await waitFor(() => expect(screen.getByTestId("root-page")).toBeTruthy());
    expect(drawn.slice(before)).toEqual([]);
  });

  // Review m3: state written while NO account is known (a late write after a sign-out purge) is
  // stamped as nobody's, and is never read as the account signed in later.
  it("state written with no account known is stamped as nobody's, and refused once B is signed in", async () => {
    const { resetIdentityForTests } = await import("../../../../src/client/lib/query");
    resetIdentityForTests();
    const written = stamped({ from: "/folder/alices-folder" });
    expect(written).toEqual({ from: "/folder/alices-folder", account: null });
    drawn = [];
    const current = { session: BOB as SessionShape };
    shellFetch({ session: () => current.session });
    seedConfig();
    await signedInAs(BOB, current);
    expect(ownHistoryState(written)).toBeNull();
    renderRoutes(routes, [{ pathname: "/preview/node-3", state: written }]);
    await screen.findByTestId("preview");
    expect(screen.getByTestId("root-page")).toBeTruthy();
    expect(drawn).toEqual([]);
  });

  it("control: an unstamped entry (nobody's) is read as it is", async () => {
    drawn = [];
    const current = { session: BOB as SessionShape };
    shellFetch({ session: () => current.session });
    seedConfig();
    await signedInAs(BOB, current);
    renderRoutes(routes, [{ pathname: "/preview/node-3", state: { from: "/folder/42" } }]);
    await screen.findByTestId("preview");
    expect(screen.getByTestId("list").textContent).toBe("folder=42");
  });
});

// Every page of the frame writes history state through `stamped(…)`.
const SOURCES = import.meta.glob(
  ["../../../../src/client/features/**/*.{ts,tsx}", "../../../../src/client/routes/frame/**/*.{ts,tsx}"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

describe("scan: history state written in the frame is stamped", () => {
  it("found the sources", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
  });

  it("every `state:` passed to navigate / setParams is stamped(…) (or passes the entry's own state on)", () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) {
      // A navigation option `state: <expr>`: the expression must be a stamped(…) call, the
      // location's own state passed along unchanged, or the preview's own stamped spread.
      for (const match of source.matchAll(
        /\b(?:navigate|setParams|setSearchParams)\([^;]*?\bstate:\s*([^,}\n]+)/g,
      )) {
        const expr = match[1]!.trim();
        if (/^stamped\(/.test(expr) || expr === "location.state") continue;
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${file.replace(/^.*src\/client\//, "")}:${line} state: ${expr}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

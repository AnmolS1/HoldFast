// The auth library keeps a session store of its own, which the shell never uses. The purger that
// empties it must not MOUNT it: a mounted store asks `GET /api/auth/get-session` by itself, listens
// for focus, and unmounts a second later from a timer that touches `document`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { betterAuthClient } from "../../../../src/client/lib/auth-client";
import { purgeUserState } from "../../../../src/client/lib/query";
import { json, mockFetch, setupShell } from "./helpers";

setupShell();

interface LibraryStore {
  active?: boolean;
  value: unknown;
  set(value: unknown): void;
  [key: symbol]: unknown;
}

const store = (): LibraryStore =>
  (betterAuthClient as unknown as { $store: { atoms: { session: LibraryStore } } }).$store.atoms.session;

afterEach(() => {
  // Should a test have mounted it after all: unmount now, while the document exists.
  const session = store();
  if (session.active !== true) return;
  const clean = Object.getOwnPropertySymbols(session).find((key) => key.description === "clean");
  if (clean) (session[clean] as () => void)();
});

describe("lib/auth-client: the purger of the library's session store", () => {
  it("a purge empties the store without mounting it: no get-session request, nothing left mounted", async () => {
    const calls = mockFetch(() => json(null));
    const before = store().value as Record<string, unknown>;
    // Something of an account in it (the library would have put it there).
    store().set({ ...before, data: { user: { id: "u".repeat(32) } }, error: null, isPending: false });
    expect(store().active).not.toBe(true);

    await purgeUserState();
    await vi.waitFor(() => expect((store().value as { data: unknown }).data).toBeNull());

    expect(store().active).not.toBe(true);
    // Long enough for a mounted store's own fetch to have left.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((call) => call.path.includes("/api/auth/get-session"))).toEqual([]);
  });
});

// The preferences sync (lib/prefs.ts `registerPrefsSync`), registered for the account that is
// signed in — once per account, from this feature's entry module.
//
// It follows the session query: when a session names an account the sync is not registered for,
// the server copy is loaded and wins, and from then on each change is saved to the server
// debounced (lib/prefs.ts). An account change purges first (lib/query.ts `adoptIdentity`): the
// purge drops the sync and any save still waiting (lib/prefs.ts's own purger, and this file's),
// and the next session answer registers it again for the new account. A save is only ever sent
// for the account it was registered for.
import type { PrefsDto } from "../../../shared/schemas/account";
import { registerUserStatePurger, type SessionShape } from "../../lib/contracts";
import { registerPrefsSync, type Prefs, type PrefsSync } from "../../lib/prefs";
import { getCachedSession, getKnownUserId, queryClient, sessionQuery } from "../../lib/query";
import { patchPrefs, prefsQuery } from "./api";

const toPrefs = (dto: PrefsDto): Prefs => ({
  theme: dto.theme,
  density: dto.density,
  viewMode: dto.viewMode,
});

/** The sync of one account's preferences. */
export function prefsSyncFor(userId: string): PrefsSync {
  return {
    async load() {
      const dto = await queryClient.fetchQuery({ ...prefsQuery, staleTime: 0 });
      return toPrefs(dto);
    },
    async save(prefs) {
      // Never as another account: a save that outlived its account is dropped.
      if (getKnownUserId() !== userId) return;
      const dto = await patchPrefs({ theme: prefs.theme, density: prefs.density, viewMode: prefs.viewMode });
      if (getKnownUserId() === userId) queryClient.setQueryData(prefsQuery.queryKey, dto);
    },
  };
}

let registeredFor: string | null = null;
let generation = 0;
let unregister: (() => void) | null = null;

function follow(session: SessionShape | undefined): void {
  const userId = session?.user.id ?? null;
  // Signed out, or a session read as nobody while it is renewed: the sync stays as it is (a
  // real sign-out purges it below).
  if (userId === null || userId === registeredFor) return;
  registeredFor = userId;
  const mine = ++generation;
  void registerPrefsSync(prefsSyncFor(userId)).then((off) => {
    if (mine === generation) unregister = off;
    else off();
  });
}

/** Starts following the session (idempotent). Called by the feature's entry module. */
let started = false;
export function startPrefsSync(): void {
  if (started) return;
  started = true;
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryKey[0] !== sessionQuery.queryKey[0]) return;
    follow(event.query.state.data as SessionShape | undefined);
  });
  follow(getCachedSession());
}

/** Forget the account: the next session answer registers the sync again. */
export function resetPrefsSync(): void {
  generation += 1;
  registeredFor = null;
  unregister?.();
  unregister = null;
}

registerUserStatePurger(resetPrefsSync);

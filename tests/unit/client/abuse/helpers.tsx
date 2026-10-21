// Shared by the abuse SPA tests (jsdom): a public config that carries a Turnstile site key, and a
// stand-in widget that passes at once (a new token after every reset, like the real one). The
// tokens and the site key are Cloudflare's published test values — made up, never a secret.
import { act } from "@testing-library/react";
import type { PublicConfig } from "../../../../src/client/lib/contracts";
import { publicConfigQuery, queryClient } from "../../../../src/client/lib/query";
import { CONFIG } from "../shell/helpers";

export const SITE_KEY = "1x00000000000000000000AA";
export const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/** The config the dialog reads, with a site key (the shell's test config has none). */
export function seedConfig(patch: Partial<PublicConfig> = {}): void {
  queryClient.setQueryData(publicConfigQuery.queryKey, { ...CONFIG, turnstileSiteKey: SITE_KEY, ...patch });
}

/** `window.turnstile`, answering every render and reset with a fresh token after a tick. */
export function stubTurnstile(): { issued: () => number; resets: () => number } {
  let issued = 0;
  let resets = 0;
  const widgets = new Map<string, { callback: (token: string) => void }>();
  const issue = (id: string) =>
    setTimeout(() => {
      const widget = widgets.get(id);
      if (!widget) return;
      issued += 1;
      void act(() => widget.callback(DUMMY_TOKEN));
    }, 0);
  window.turnstile = {
    render(_element, options) {
      const id = `w${widgets.size + 1}`;
      widgets.set(id, options);
      issue(id);
      return id;
    },
    reset(id) {
      resets += 1;
      for (const known of id === undefined ? widgets.keys() : [id]) issue(known);
    },
    remove(id) {
      widgets.delete(id);
    },
  };
  return { issued: () => issued, resets: () => resets };
}

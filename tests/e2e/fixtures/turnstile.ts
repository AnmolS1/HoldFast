// The Turnstile widget script is the vendor's, loaded from challenges.cloudflare.com by every auth
// screen. Specs that are not about the widget replace it with a stand-in that passes at once, so
// a run needs no network and never depends on the vendor's page.
//
// Like the real widget, the stand-in issues a NEW token after `reset()`: a token is single-use,
// every form resets the widget after a submit that spent one, and a stand-in that stayed silent
// after a reset left the second submit on a page waiting for a token for ever. Each token is the
// published dummy token (what the server's test secret accepts), delivered through the callback
// the page registered; `window.__turnstileStub` counts them for the harness's own test.
import type { Page } from "@playwright/test";

export const TURNSTILE_STUB_SCRIPT = `(() => {
  const widgets = new Map();
  const stub = { issued: 0, resets: 0 };
  const issue = (id) => setTimeout(() => {
    const options = widgets.get(id);
    if (!options) return;
    stub.issued += 1;
    options.callback('XXXX.DUMMY.TOKEN.XXXX');
  }, 10);
  window.__turnstileStub = stub;
  window.turnstile = {
    render(element, options) {
      const id = 'w' + (widgets.size + 1);
      widgets.set(id, options);
      issue(id);
      return id;
    },
    reset(id) {
      stub.resets += 1;
      for (const known of id === undefined ? widgets.keys() : [id]) issue(known);
    },
    remove(id) {
      widgets.delete(id);
    },
  };
})();`;

export async function stubTurnstile(page: Page): Promise<void> {
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({ contentType: "text/javascript", body: TURNSTILE_STUB_SCRIPT }),
  );
}

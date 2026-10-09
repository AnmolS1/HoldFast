// The Turnstile widget script is the vendor's, loaded from challenges.cloudflare.com by every auth
// screen. Specs that are not about the widget replace it with a stand-in that passes at once, so
// a run needs no network and never depends on the vendor's page.
import type { Page } from "@playwright/test";

export async function stubTurnstile(page: Page): Promise<void> {
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: "window.turnstile={render:function(el,o){setTimeout(function(){o.callback('XXXX.DUMMY.TOKEN.XXXX')},10);return 'w'},reset:function(){},remove:function(){}};",
    }),
  );
}

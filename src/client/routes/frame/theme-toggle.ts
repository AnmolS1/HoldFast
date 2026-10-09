import { setPrefs } from "../../lib/prefs";

/** The scheme currently on screen, whatever the preference says. */
export function isDarkNow(): boolean {
  return document.documentElement.hasAttribute("data-dark");
}

export function toggleTheme(): void {
  setPrefs({ theme: isDarkNow() ? "light" : "dark" });
}

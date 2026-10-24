// What this browser can do — checks with no feature or route behind them, shared by the frame and features.

/**
 * Can this browser pick a folder? There is no reliable test (the property can exist while the
 * system's picker hands back plain files — the uploader refuses such a pick), so this only keeps
 * Upload folder from being offered (the FAB, the explorer's empty state and folder menu) where it is known not to work: no `webkitdirectory`, or Samsung
 * Internet (caniuse "input-file-directory", 2026-10-23).
 */
export function canPickFolders(): boolean {
  // Read off `globalThis`: this module is also type-checked without the DOM library.
  const input = (globalThis as { HTMLInputElement?: { prototype: object } }).HTMLInputElement;
  if (!input || typeof navigator === "undefined") return false;
  return "webkitdirectory" in input.prototype && !/SamsungBrowser/i.test(navigator.userAgent);
}

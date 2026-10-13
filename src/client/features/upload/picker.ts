// The file pickers and the target folder. The two hidden inputs are rendered by the feature's
// host component (the frame's drop overlay slot) and register themselves here, so `requestUpload`
// — a plain function — can open one inside the click that asked for it.
export type PickerKind = "files" | "folder";

const inputs: Record<PickerKind, HTMLInputElement | null> = { files: null, folder: null };
let pickerParent: string | null = null;

export function registerPicker(kind: PickerKind, input: HTMLInputElement | null): void {
  inputs[kind] = input;
}

/** Where the files of the picker that is open go. */
export function pickerTarget(): string | null {
  return pickerParent;
}

/**
 * Open the browser's picker. Synchronous on purpose: a picker only opens while the user's click
 * is still being handled.
 */
export function openPicker(kind: PickerKind, parentId: string | null): void {
  pickerParent = parentId;
  inputs[kind]?.click();
}

/**
 * The folder the current page shows: `/folder/:id`, or `/uploads?parent=:id`; anywhere else the
 * top level (null). Read from the address, so nothing here depends on another feature.
 */
export function targetFromLocation(): string | null {
  if (typeof location === "undefined") return null;
  const folder = /^\/folder\/([^/]+)\/?$/.exec(location.pathname);
  if (folder) return decodeURIComponent(folder[1]!);
  if (/^\/uploads\/?$/.test(location.pathname)) {
    return new URLSearchParams(location.search).get("parent") || null;
  }
  return null;
}

// The file pickers and the target folder. The two hidden inputs are rendered by the feature's
// host component (the frame's drop overlay slot) and register themselves here, so `requestUpload`
// — a plain function — can open one inside the click that asked for it.
import { NodeId } from "../../../shared/schemas/common";

export type PickerKind = "files" | "folder";

const inputs: Record<PickerKind, HTMLInputElement | null> = { files: null, folder: null };
/** `undefined`: no picker was opened by `openPicker` (the input was reached some other way). */
let pickerParent: string | null | undefined;

export function registerPicker(kind: PickerKind, input: HTMLInputElement | null): void {
  inputs[kind] = input;
}

/**
 * Where the files a picker just handed over go: the folder it was opened for — and for an input
 * that was not opened through `openPicker`, the folder in the address. Asked once per selection.
 */
export function takePickerTarget(): string | null {
  const target = pickerParent === undefined ? targetFromLocation() : pickerParent;
  pickerParent = undefined;
  return target;
}

/**
 * Open the browser's picker. Synchronous on purpose: a picker only opens while the user's click
 * is still being handled.
 */
export function openPicker(kind: PickerKind, parentId: string | null): void {
  pickerParent = parentId;
  inputs[kind]?.click();
}

/** Forget what a picker was opened for (the account's state ends). */
export function resetPicker(): void {
  pickerParent = undefined;
}

/** A folder id out of the address: only a well-formed id is one — it goes into request paths. */
function folderId(raw: string | null): string | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return NodeId.safeParse(decoded).success ? decoded : null;
}

/**
 * The folder the current page shows: `/folder/:id`, or `/uploads?parent=:id`; anywhere else — and
 * for anything that is not an id — the top level (null). Read from the address, so nothing here
 * depends on another feature.
 */
export function targetFromLocation(): string | null {
  if (typeof location === "undefined") return null;
  const folder = /^\/folder\/([^/]+)\/?$/.exec(location.pathname);
  if (folder) return folderId(folder[1]!);
  if (/^\/uploads\/?$/.test(location.pathname)) {
    // Already decoded by URLSearchParams; `folderId` decodes once more, which an id survives.
    return folderId(encodeURIComponent(new URLSearchParams(location.search).get("parent") ?? ""));
  }
  return null;
}

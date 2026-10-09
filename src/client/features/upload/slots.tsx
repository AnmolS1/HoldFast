// PLACEHOLDER — taken over by the uploader task (T17), which fills both bodies and keeps the
// names and types. The frame renders `UploadDropOverlay` once at its root; the FAB, the header
// "New" menu and the palette call `requestUpload`.
import type { RequestUpload } from "../../components/slots";

/** Stub: renders nothing. The real overlay shows "Drop to upload to <folder>". */
export function UploadDropOverlay(): null {
  return null;
}

/** Stub: no-op. The real function opens the file picker or enqueues the given files. */
// eslint-disable-next-line react-refresh/only-export-components -- the slot file exports both by contract
export const requestUpload: RequestUpload = () => {};

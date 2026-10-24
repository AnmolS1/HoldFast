// The two slots the shell pre-wired: the frame renders `UploadDropOverlay` once at its root; the
// FAB, the header's "New" menu, the palette and the explorer call `requestUpload`.
import type { RequestUpload } from "../../components/slots";
import { actionMark, addFiles } from "./manager";
import { openPicker, targetFromLocation } from "./picker";
import "./ribbon";
import { UploadHost } from "./UploadHost";

/** Dragging files over the app shows "Drop to upload to <folder>"; the folder is the one in the address. */
export function UploadDropOverlay() {
  return <UploadHost />;
}

/**
 * Upload `files` into `parentId`; without files, open the picker `kind` names (the file picker
 * unless it is `"folder"`). Without a folder the one in the address is used, else the top level.
 */
// eslint-disable-next-line react-refresh/only-export-components -- the slot file exports both by contract
export const requestUpload: RequestUpload = (opts) => {
  const parentId = opts?.parentId ?? targetFromLocation();
  if (opts?.files) {
    void addFiles(
      opts.files.map((file) => ({ file })),
      parentId,
      [],
      {},
      actionMark(),
    );
    return;
  }
  openPicker(opts?.kind ?? "files", parentId);
};

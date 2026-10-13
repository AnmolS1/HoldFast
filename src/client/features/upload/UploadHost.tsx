// The uploader's one always-mounted piece, rendered by the frame through the drop-overlay slot:
// the drop target, the paste listener, the two hidden pickers, the conflict dialog and the live
// region that announces each file. Mounting it reads the resume list from the device and makes no
// request.
import Box from "@mui/material/Box";
import { Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { accountEpoch, sameAccount, useSession } from "../../lib/query";
import { isEditableTarget } from "../../lib/shortcuts";
import { hf, layout } from "../../theme/tokens";
import { ConflictDialog } from "./ConflictDialog";
import { carriesFiles, fromDrop, fromFileList } from "./intake";
import { actionMark, addFiles, frameMounted, restoreUploads, sameActor } from "./manager";
import { registerPicker, takePickerTarget, targetFromLocation } from "./picker";
import { getNode } from "./protocol";
import { useUploads } from "./store";
import { t } from "./strings";

const hidden = {
  position: "absolute",
  // "1px", not 1: a bare 1 in `sx` is 100 %.
  width: "1px",
  height: "1px",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

interface DropTarget {
  parentId: string | null;
  folder: string;
}

export function UploadHost() {
  const { items, announcements } = useUploads();
  const [target, setTarget] = useState<DropTarget | null>(null);
  const depth = useRef(0);

  // The device's list is read for whoever is signed in — again when that changes without a reload.
  const userId = useSession().data?.user.id;
  useEffect(() => {
    if (userId) void restoreUploads();
  }, [userId]);

  // Leaving the frame (a public page, the sign-in screen) stops what is running: nothing reads a
  // file or sends a body for a page that shows no progress. The rows wait, paused.
  useEffect(() => {
    frameMounted(true);
    return () => frameMounted(false);
  }, []);

  useEffect(() => {
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current += 1;
      if (depth.current > 1) return;
      const parentId = targetFromLocation();
      setTarget({ parentId, folder: parentId === null ? t("drop.root") : t("drop.thisFolder") });
      if (parentId === null) return;
      // The folder's name, for the sentence — asked each time and kept nowhere: it is the
      // account's. An answer that arrives after the account changed is not shown.
      const account = accountEpoch();
      getNode(parentId).then(
        (detail) => {
          if (!sameAccount(account)) return;
          setTarget((shown) =>
            shown?.parentId === parentId ? { parentId, folder: detail.node.name } : shown,
          );
        },
        () => {},
      );
    };
    const over = (event: DragEvent) => {
      // Without this the browser opens the file instead of handing it over.
      if (carriesFiles(event.dataTransfer)) event.preventDefault();
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setTarget(null);
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer) || !event.dataTransfer) return;
      event.preventDefault();
      depth.current = 0;
      setTarget(null);
      const parentId = targetFromLocation();
      // Whose drop this is, taken now: the walk below can outlive the account that dropped.
      const then = actionMark();
      // `wanted` ends the walk early; `addFiles` itself refuses a stale mark.
      void fromDrop(event.dataTransfer, () => sameActor(then)).then((intake) =>
        addFiles(intake.files, parentId, intake.folders, intake, then),
      );
    };
    const paste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0 || isEditableTarget(event.target)) return;
      event.preventDefault();
      void addFiles(fromFileList(files).files, targetFromLocation(), [], {}, actionMark());
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("paste", paste);
    };
  }, []);

  const picked = (input: HTMLInputElement) => {
    const intake = fromFileList(Array.from(input.files ?? []));
    // Emptied, so choosing the same file again is a change again.
    input.value = "";
    void addFiles(intake.files, takePickerTarget(), intake.folders, intake, actionMark());
  };

  return (
    <>
      <input
        ref={(node) => registerPicker("files", node)}
        type="file"
        multiple
        hidden
        data-upload-input="files"
        aria-label={t("input.files")}
        onChange={(event) => picked(event.currentTarget)}
      />
      <input
        ref={(node) => registerPicker("folder", node)}
        type="file"
        multiple
        hidden
        data-upload-input="folder"
        aria-label={t("input.folder")}
        onChange={(event) => picked(event.currentTarget)}
        {...{ webkitdirectory: "" }}
      />
      <Box role="log" aria-live="polite" aria-label={t("live.label")} data-upload-live sx={hidden}>
        {announcements.map((entry) => (
          <div key={entry.id}>{entry.text}</div>
        ))}
      </Box>
      {target ? (
        <Box
          data-upload-drop
          sx={{
            position: "fixed",
            inset: 0,
            // Above everything the page draws, dialogs included: the drop is what is happening.
            zIndex: (theme) => theme.zIndex.tooltip,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            p: 4,
            backgroundColor: hf.scrim,
            // The window's own drag events drive this; the layer must not swallow them.
            pointerEvents: "none",
          }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 3,
              py: 4,
              px: 5,
              maxWidth: "100%",
              borderRadius: `${layout.radius.dialog}px`,
              border: `2px dashed ${hf.text}`,
              backgroundColor: hf.surface,
              color: hf.text,
              typography: "h3",
              overflowWrap: "anywhere",
            }}
          >
            <Upload size={20} aria-hidden="true" style={{ flex: "none" }} />
            {t("drop.to", { folder: target.folder })}
          </Box>
        </Box>
      ) : null}
      <ConflictDialog items={items} />
    </>
  );
}

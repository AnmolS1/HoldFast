// Drag-and-drop of rows onto folders and onto the header's breadcrumbs. Dragging OS files onto
// the window is the uploader's overlay, not this: the two are told apart by the data type.
import type { CSSProperties } from "react";
import { hf } from "../../theme/tokens";

/** Carried by a drag that started on an explorer row. An OS file drag carries "Files" instead. */
export const DRAG_TYPE = "application/x-holdfast-nodes";

/** The dashed ring a drop target shows. */
export const DROP_RING: CSSProperties = { outline: `2px dashed ${hf.text}`, outlineOffset: -2 };

export const isNodeDrag = (transfer: DataTransfer | null) =>
  Boolean(transfer && Array.from(transfer.types).includes(DRAG_TYPE));

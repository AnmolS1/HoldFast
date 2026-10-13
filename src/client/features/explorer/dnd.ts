// Drag-and-drop of rows onto folders and onto the header's breadcrumbs. Dragging OS files onto
// the window is the uploader's overlay, not this: the two are told apart by the data type.
import { useEffect, useRef, type CSSProperties } from "react";
import { hf } from "../../theme/tokens";

/** Carried by a drag that started on an explorer row. An OS file drag carries "Files" instead. */
export const DRAG_TYPE = "application/x-holdfast-nodes";

/** The dashed ring a drop target shows. */
export const DROP_RING: CSSProperties = { outline: `2px dashed ${hf.text}`, outlineOffset: -2 };

export const isNodeDrag = (transfer: DataTransfer | null) =>
  Boolean(transfer && Array.from(transfer.types).includes(DRAG_TYPE));

/** The folder a breadcrumb link leads to: `null` for the top level, undefined when it is no folder. */
export function folderOfHref(href: string | null): string | null | undefined {
  if (href === "/") return null;
  const match = /^\/folder\/([^/?#]+)$/.exec(href ?? "");
  return match ? decodeURIComponent(match[1]!) : undefined;
}

/**
 * Makes the header's breadcrumb links drop targets while a row is being dragged. The header is
 * the frame's: its trail component takes no drop handlers, so the links are found by delegation
 * (a link inside the header's breadcrumb navigation) and ringed with an inline outline.
 */
export function useBreadcrumbDrop(
  enabled: boolean,
  onDrop: (folderId: string | null, label: string) => void,
): void {
  const latest = useRef(onDrop);
  useEffect(() => {
    latest.current = onDrop;
  });
  useEffect(() => {
    if (!enabled) return;
    let ringed: HTMLElement | null = null;
    const ring = (element: HTMLElement | null) => {
      if (ringed === element) return;
      if (ringed) {
        ringed.style.outline = "";
        ringed.style.outlineOffset = "";
        ringed.removeAttribute("data-drop-target");
      }
      ringed = element;
      if (ringed) {
        ringed.style.outline = String(DROP_RING.outline);
        ringed.style.outlineOffset = "2px";
        ringed.setAttribute("data-drop-target", "true");
      }
    };
    const crumbOf = (event: DragEvent): HTMLElement | null => {
      if (!isNodeDrag(event.dataTransfer) || !(event.target instanceof Element)) return null;
      const link = event.target.closest<HTMLElement>("[data-header] nav a[href]");
      return link && folderOfHref(link.getAttribute("href")) !== undefined ? link : null;
    };
    const onDragOver = (event: DragEvent) => {
      const link = crumbOf(event);
      ring(link);
      if (!link) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    };
    const onDropEvent = (event: DragEvent) => {
      const link = crumbOf(event);
      ring(null);
      if (!link) return;
      event.preventDefault();
      const folderId = folderOfHref(link.getAttribute("href"));
      if (folderId !== undefined) latest.current(folderId, link.textContent ?? "");
    };
    const clear = () => ring(null);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDropEvent);
    document.addEventListener("dragend", clear);
    return () => {
      ring(null);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDropEvent);
      document.removeEventListener("dragend", clear);
    };
  }, [enabled]);
}

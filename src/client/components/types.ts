// Structural item types of the shared components. They are structural on purpose: the node DTO
// of the contracts task is assignable without an import.

/** Identical to the database enum. */
export type ScanStatus =
  "pending" | "clean" | "infected" | "suspected_csam" | "under_review" | "skipped" | "error";

export type MimeCategory = "image" | "video" | "audio" | "pdf" | "document" | "archive" | "code" | "other";

export interface FileListItem {
  id: string;
  kind: "file" | "folder";
  name: string;
  size: number | null;
  mimeCategory: MimeCategory;
  scanStatus: ScanStatus;
  scanReason?: string | null;
  updatedAt: string;
  sharing?: { people: number; link: "none" | "active" | "paused" | "expired" };
  /** Owner name in shared views, path hint in search, "Deleted on …" in trash. */
  secondary?: string;
  /** 0..1 while uploading/verifying/scanning; null = indeterminate; undefined = none. */
  progress?: number | null;
}

export type FileListColumn = "share" | "modified" | "size";
export type FileListView = "list" | "grid";
export type SelectionCause = "click" | "range" | "toggle" | "all" | "clear" | "longpress";

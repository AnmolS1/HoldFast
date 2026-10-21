// Props of the typed slot components. The placeholder feature modules export stubs with exactly
// these props, so consumers compile and integrate in any order; the owning task replaces the stub
// file and keeps the props. Cross-feature imports go only through `features/<name>/index.ts`.
import type { MimeCategory, ScanStatus } from "./types";

/** `linkToken` is the proof of access on public pages. */
export interface ReportTarget {
  nodeId: string;
  linkToken?: string;
}

export interface ReportLinkProps {
  target: ReportTarget;
}

export interface ReportDialogProps {
  open: boolean;
  onClose(): void;
  target: ReportTarget;
}

export interface DangerousFileInterstitialProps {
  fileName: string;
  onContinue(): void;
  onCancel(): void;
}

export interface PreviewItem {
  id: string;
  name: string;
  size: number;
  mimeCategory: MimeCategory;
  ext: string;
  mimeSniffed?: string | null;
  /** Whether a thumbnail may be asked for, as on a node; absent = not known. */
  thumb?: boolean;
  /** Absent = the source does not say (a public page serves clean files only). */
  scanStatus?: ScanStatus;
}

/** A public page supplies metadata and URLs itself; `"owner"` means the authenticated API. */
export interface PublicPreviewSource {
  getItem(nodeId: string): Promise<PreviewItem>;
  getUrl(
    nodeId: string,
    kind: "inline" | "thumb",
    size?: number,
  ): Promise<{ url: string; expiresAt: string }>;
  /**
   * What the preview's Report targets for this file: on a public page, the link's token is the
   * proof of access (fold-w3 #20). Absent: the signed-in report route.
   */
  reportTarget?(nodeId: string): ReportTarget;
}

export interface PreviewDialogProps {
  open: boolean;
  nodeId: string | null;
  siblingIds?: string[];
  onNavigate?(nodeId: string): void;
  onClose(): void;
  source: "owner" | PublicPreviewSource;
}

export interface ShareDialogProps {
  open: boolean;
  nodeId: string | null;
  onClose(): void;
}

export interface SearchSuggestionsProps {
  query: string;
  onPick(nodeId: string): void;
}

/** What `useUsageSummary()` returns once the usage is known. */
export interface UsageSummary {
  usedBytes: number;
  quotaBytes: number;
}

/**
 * `useUsageSummary()`: the usage; `null` while it is loading (the bar shows its skeleton);
 * `"unavailable"` when it could not be read (the bar says so — never a skeleton for ever).
 */
export type UsageSlotValue = UsageSummary | "unavailable" | null;

export interface RequestUploadOptions {
  files?: File[];
  parentId?: string;
}

export type RequestUpload = (opts?: RequestUploadOptions) => void;

/**
 * Route `handle` flags the shell reads.
 *  - `public`: rendered outside the app frame and every auth guard; a 401 there never opens the
 *    re-auth modal.
 *  - `overlay`: rendered above the content pane while the previous page stays mounted underneath.
 *  - `details: false`: hide the desktop details panel on this route (wide pages).
 *  - `title`: the default header title (a feature can set richer breadcrumbs at run time).
 */
export interface RouteHandle {
  public?: boolean;
  auth?: boolean;
  overlay?: boolean;
  details?: boolean;
  title?: string;
}

// Shapes the shell reads. Defined here because the shell is built before the auth and contract
// tasks; they are structural, so the real session and DTO types are assignable without an import.
import { z } from "zod";

export { PublicConfig } from "../../shared/public-config";
export { ERROR_STATUS, INTERNAL_ERROR, isErrorCode } from "../../shared/errors";
export type { ErrorCode, ErrorEnvelope, InternalErrorEnvelope } from "../../shared/errors";

/** The user fields the shell reads from the session. Dates arrive as ISO strings in the browser. */
export const SessionUserShape = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  role: z.string().nullish(),
  timezone: z.string().nullish(),
  termsVersion: z.string().nullish(),
  deleteScheduledAt: z.string().nullish(),
});
export type SessionUserShape = z.infer<typeof SessionUserShape>;

/** `GET /api/auth/get-session`: the session with its user, or `null` when signed out. */
export const SessionShape = z
  .object({
    user: SessionUserShape,
    session: z.object({
      /** Admin plugin: set on an impersonated session to the admin's user id. */
      impersonatedBy: z.string().nullish(),
    }),
  })
  .nullable();
export type SessionShape = z.infer<typeof SessionShape>;

export function isImpersonating(session: SessionShape | undefined): boolean {
  return Boolean(session?.session.impersonatedBy);
}

/** `GET /api/account/deletion-status`. */
export const DeletionStatusShape = z.object({ scheduledFor: z.string().nullable() });
export type DeletionStatusShape = z.infer<typeof DeletionStatusShape>;

/** `GET /api/invites/:code`. */
export const InviteStatusShape = z.object({ valid: z.boolean() });

/** Where the legal texts and help live (the estate site). */
export const EXTERNAL_LINKS = {
  terms: "https://ponderance.dev/terms",
  privacy: "https://ponderance.dev/privacy",
  help: "https://ponderance.dev/support/holdfast",
  support: "https://ponderance.dev/support/holdfast#contact",
} as const;

// ---------------------------------------------------------------------------------------------
// User-scoped client state. RULE FOR EVERY FEATURE: anything held in memory or on the device that
// belongs to the signed-in account — a zustand store, an upload queue, an idb-keyval entry, a
// module-level cache — registers a purger here at module load. `purgeUserState()` (lib/query.ts)
// runs them all on sign-out and whenever the signed-in identity changes, so nothing cached or
// queued for one account can be shown to, or acted on by, another. TanStack Query data needs no
// purger: the whole cache (except the public config) is cleared by the same routine.

export type UserStatePurger = () => void | Promise<void>;

const userStatePurgers = new Set<UserStatePurger>();

/** Register a purger; returns the function that removes it again. */
export function registerUserStatePurger(purger: UserStatePurger): () => void {
  userStatePurgers.add(purger);
  return () => {
    userStatePurgers.delete(purger);
  };
}

/** Run every registered purger. One failing purger never stops the others. */
export async function runUserStatePurgers(): Promise<void> {
  await Promise.allSettled(Array.from(userStatePurgers, async (purger) => purger()));
}

// ---------------------------------------------------------------------------------------------
// "The tree changed" — the one event features use to tell each other, since no feature imports
// another. Whoever creates, renames, moves, trashes, restores, deletes or uploads emits it after
// the change is saved; every feature that shows nodes listens and invalidates its OWN queries.

export const NODES_CHANGED_EVENT = "holdfast:nodes-changed";

/** The folders whose direct children changed; `null` is the top level. */
export interface NodesChangedDetail {
  parentIds: (string | null)[];
}

// The browser's `window`, named through `globalThis`: this module is also type-checked for the
// Workers runtime (a contract test imports it), whose types have no `window`.
const bus = (): EventTarget => globalThis as unknown as EventTarget;

/** Tell every listener that the children of these folders changed. */
export function emitNodesChanged(parentIds: (string | null)[]): void {
  bus().dispatchEvent(new CustomEvent<NodesChangedDetail>(NODES_CHANGED_EVENT, { detail: { parentIds } }));
}

/** Listen for tree changes; returns the function that stops listening. */
export function onNodesChanged(handler: (detail: NodesChangedDetail) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<NodesChangedDetail | undefined>).detail;
    // An event of this name that does not carry the contract's detail is not one of ours.
    if (Array.isArray(detail?.parentIds)) handler(detail);
  };
  bus().addEventListener(NODES_CHANGED_EVENT, listener);
  return () => bus().removeEventListener(NODES_CHANGED_EVENT, listener);
}

// ---------------------------------------------------------------------------------------------
// Scan verdicts between the uploader and the listings (R1 a11y-3: one owner per verdict). The
// explorer tells what its listing learned (`scanVerdictsSeen`) and asks, before it says a verdict,
// whether it is the uploader's to say (`scanVerdictOwned`) — without importing the uploader. The
// uploader registers itself when it starts following a scan; the registration is the account's
// and goes with the purge (the uploader's own state is purged by its own purger).

/** What the registry needs of a node: its id, its version and its scan state. */
export interface ScanVerdictNode {
  id: string;
  etag: string | null;
  kind: "file" | "folder";
  scanStatus: string | null;
}

export interface ScanVerdictOwner {
  /** A listing learned the state of these nodes. */
  seen(nodes: readonly ScanVerdictNode[]): void;
  /** Is this node's verdict the owner's to say? */
  owns(node: Pick<ScanVerdictNode, "id" | "etag">): boolean;
}

let scanVerdictOwner: ScanVerdictOwner | null = null;

/** Become the owner of the verdicts you follow (idempotent); returns the function that steps down. */
export function registerScanVerdictOwner(owner: ScanVerdictOwner): () => void {
  scanVerdictOwner = owner;
  return () => {
    if (scanVerdictOwner === owner) scanVerdictOwner = null;
  };
}

/** Tell the owner what a listing learned. Nothing happens without one. */
export function scanVerdictsSeen(nodes: readonly ScanVerdictNode[]): void {
  scanVerdictOwner?.seen(nodes);
}

/** True when the owner says this verdict is its to say; false without one. */
export function scanVerdictOwned(node: Pick<ScanVerdictNode, "id" | "etag">): boolean {
  return scanVerdictOwner?.owns(node) ?? false;
}

registerUserStatePurger(() => {
  scanVerdictOwner = null;
});

// ---------------------------------------------------------------------------------------------
// "Upload into this folder" from a page of another feature: the uploader's slot, asked without
// importing the uploader. The uploader's host registers it while the frame shows it. A function
// of the app, not of an account: the purge does not remove it (what it queues is the uploader's,
// and that is purged by the uploader's own purger).

/** The slot's options, structurally `RequestUploadOptions` (components/slots.ts). */
export interface UploadRequest {
  files?: File[];
  parentId?: string;
  /** Without `files`: which picker opens (default `"files"`). */
  kind?: "files" | "folder";
}

let uploadRequester: ((opts?: UploadRequest) => void) | null = null;

/** Answer upload requests; returns the function that stops answering them. */
export function registerUploadRequester(requester: (opts?: UploadRequest) => void): () => void {
  uploadRequester = requester;
  return () => {
    if (uploadRequester === requester) uploadRequester = null;
  };
}

/** Ask the uploader to upload `files` into `parentId` (without files: the picker). Nothing without one. */
export function requestUpload(opts?: UploadRequest): void {
  uploadRequester?.(opts);
}

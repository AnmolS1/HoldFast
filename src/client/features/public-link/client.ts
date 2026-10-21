// One public link, as its page talks to it. No account is involved: the proof of the password is
// the LINK SESSION, kept here in memory only (never a cookie, never a store of the browser) and
// sent as the `X-Holdfast-Link-Session` header on every `/api/public/links/:token/*` call.
//
// LOCKED. The link needs its password and this page holds no valid session: at first, when the
// info says so, and again whenever ANY call answers `403 password_required` — the owner changed
// the password, or the session ran out. Being locked drops the session and the zip grant, tells
// the page once (it closes the preview, stops a zip and shows the form), and from then on every
// call that needs the session REJECTS AT ONCE WITHOUT A REQUEST: the preview's three proactive
// retries (15, 30, 60 s) cost nothing and raise no second form.
import {
  PublicChildrenResponse,
  PublicDownloadUrlResponse,
  PublicDownloadUrlsResponse,
  PublicLinkInfo,
  PublicZipManifest,
  UnlockResponse,
  type PublicDownloadUrlBody,
  type PublicDownloadUrlsBody,
  type PublicNodeDto,
} from "../../../shared/schemas/link";
import { HEADER_LINK_SESSION } from "../../../shared/constants";
import type { PreviewItem, PublicPreviewSource, ReportTarget } from "../../components/slots";
import { api, ApiError, type ApiErrorCode } from "../../lib/api";
import { t } from "./strings";

/** Everything this page says in its own words: no shell toast for these. */
const OWN_WORDS: readonly ApiErrorCode[] = [
  "not_found",
  "link_expired",
  "link_paused",
  "password_required",
  "rate_limited",
  "ceiling_exceeded",
  "forbidden",
  "validation",
];

export const isPasswordRequired = (error: unknown): boolean =>
  error instanceof ApiError && error.code === "password_required";

/** A wrong password (as opposed to "no session"): the form says so. */
export const isWrongPassword = (error: unknown): boolean =>
  isPasswordRequired(error) && (error as ApiError).details?.wrongPassword === true;

/** What a call that needs the session rejects with while the link is locked. No request is made. */
export function lockedError(): ApiError {
  return new ApiError({ status: 403, code: "password_required", message: t("public.password.title") });
}

export type Refusal = "gone" | "limit" | "traffic" | "unavailable" | "error";

/** The one sentence for a link that does not answer. */
export function refusalOf(error: unknown): Refusal {
  if (!(error instanceof ApiError)) return "error";
  const reason = error.details?.reason;
  if (error.status === 404) return "gone";
  if (error.status === 410) return reason === "limit_reached" ? "limit" : "gone";
  if (error.status === 423) return reason === "traffic" ? "traffic" : "unavailable";
  return "error";
}

export type MintOptions = { zipGrant?: string; dangerousAck?: boolean; size?: number };

export class LinkClient {
  readonly token: string;
  #session: string | null = null;
  #locked = false;
  #needsPassword = false;
  #listeners = new Set<() => void>();
  /** Every node the page has been told about, for the preview's `getItem`. */
  #known = new Map<string, PublicNodeDto>();

  constructor(token: string) {
    this.token = token;
  }

  // ── the lock, as an external store ──

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  isLocked = (): boolean => this.#locked;

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  /** Locked again: the session goes, and the page is told — once, however many calls fail. */
  lock(): void {
    this.#session = null;
    if (this.#locked) return;
    this.#locked = true;
    this.#emit();
  }

  // ── calls ──

  #path(rest = ""): string {
    return `/api/public/links/${encodeURIComponent(this.token)}${rest}`;
  }

  async #call<T>(rest: string, options: Parameters<typeof api<T>>[1] = {}): Promise<T> {
    const headers: Record<string, string> = { ...options.headers };
    if (this.#session) headers[HEADER_LINK_SESSION] = this.#session;
    try {
      return await api<T>(this.#path(rest), { ...options, headers, silent: OWN_WORDS });
    } catch (error) {
      if (isPasswordRequired(error) && !isWrongPassword(error)) this.lock();
      throw error;
    }
  }

  /** A call that needs the session: refused here while locked. */
  async #unlockedCall<T>(rest: string, options: Parameters<typeof api<T>>[1] = {}): Promise<T> {
    if (this.#locked) throw lockedError();
    return this.#call(rest, options);
  }

  async info(): Promise<PublicLinkInfo> {
    const info = await this.#call("", { schema: PublicLinkInfo });
    this.#needsPassword = info.requiresPassword;
    if (info.node === null && info.requiresPassword) this.lock();
    if (info.node) this.#known.set(info.node.id, info.node);
    return info;
  }

  /** The password: a session, and the lock lifted. A wrong one rejects (`isWrongPassword`). */
  async unlock(password: string): Promise<void> {
    const answer = await this.#call("/unlock", {
      method: "POST",
      body: { password },
      schema: UnlockResponse,
    });
    this.#session = answer.linkSession;
    if (this.#locked) {
      this.#locked = false;
      this.#emit();
    }
  }

  async children(folderId: string | null, cursor: string | null): Promise<PublicChildrenResponse> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = await this.#unlockedCall(
      `/children${folderId ? `/${encodeURIComponent(folderId)}` : ""}${query}`,
      {
        schema: PublicChildrenResponse,
      },
    );
    for (const item of page.items) this.#known.set(item.id, item);
    return page;
  }

  mint(
    nodeId: string,
    kind: "download" | "inline" | "thumb",
    options: MintOptions = {},
  ): Promise<PublicDownloadUrlResponse> {
    const body: PublicDownloadUrlBody =
      kind === "thumb"
        ? { nodeId, kind, size: (options.size ?? 320) as 160 | 320 | 1280 }
        : {
            nodeId,
            kind,
            ...(options.dangerousAck ? { dangerousAck: true } : {}),
            ...(options.zipGrant ? { zipGrant: options.zipGrant } : {}),
          };
    return this.#unlockedCall("/download-url", { method: "POST", body, schema: PublicDownloadUrlResponse });
  }

  /** One window of a zip's URLs in ONE request, under its grant (one hit of the limiter). */
  mintBatch(nodeIds: string[], zipGrant: string, dangerousAck = false): Promise<PublicDownloadUrlsResponse> {
    const body: PublicDownloadUrlsBody = {
      zipGrant,
      nodeIds,
      ...(dangerousAck ? { dangerousAck: true } : {}),
    };
    return this.#unlockedCall("/download-urls", { method: "POST", body, schema: PublicDownloadUrlsResponse });
  }

  zipManifest(): Promise<PublicZipManifest> {
    return this.#unlockedCall("/zip-manifest", { method: "POST", body: {}, schema: PublicZipManifest });
  }

  /**
   * A report of `nodeId` as this page proves access: the link's token, and the link session as it
   * is NOW — read at each call, so an unlock after the page was built counts; none while locked.
   */
  reportTarget(nodeId: string): ReportTarget {
    return { nodeId, linkToken: this.token, ...(this.#session ? { linkSession: this.#session } : {}) };
  }

  /** Whether this link has a password at all (the info said so). */
  get needsPassword(): boolean {
    return this.#needsPassword;
  }

  // ── the preview's source (T08's contract) ──

  /**
   * What `PreviewDialog` reads through. Only `inline` and `thumb` are ever minted here — a
   * preview never consumes a download. `getItem` answers from what the page was already told: a
   * public file is clean, so it never polls.
   */
  source(): PublicPreviewSource {
    return {
      getItem: async (nodeId: string): Promise<PreviewItem> => {
        const node = this.#known.get(nodeId);
        if (!node || node.kind !== "file") {
          throw new ApiError({ status: 404, code: "not_found", message: t("public.state.gone") });
        }
        return {
          id: node.id,
          name: node.name,
          size: node.size,
          mimeCategory: node.mimeCategory,
          ext: node.ext,
          mimeSniffed: node.mimeSniffed,
          thumb: node.thumb,
        };
      },
      getUrl: async (nodeId: string, kind: "inline" | "thumb", size?: number) => {
        const minted = await this.mint(nodeId, kind, { size });
        return { url: minted.url, expiresAt: minted.expiresAt };
      },
      // The previewed file is reported with the link's token: what the visitor was shown.
      reportTarget: (nodeId: string) => this.reportTarget(nodeId),
    };
  }
}

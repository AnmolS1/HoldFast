// A stand-in for the node API, in memory: the routes the explorer calls, answering with shapes
// parsed by the contract schemas. Used by the jsdom tests (through a fetch stub) and by the
// Playwright spec (through page.route) — one fake, so the two cannot disagree about the API.
// It imports no test runner.
import {
  BatchDownloadUrlsResponse,
  DownloadUrlResponse,
  NodeDetailDto,
  NodeDto,
  NodePage,
  RestoreNodeResponse,
  ScanStatusResponse,
  ThumbUrlResponse,
  TrashNodeResponse,
  ZipManifest,
} from "../../../../../src/shared/schemas/node";
import { AT, folderNode } from "./nodes";

export interface DriveCall {
  method: string;
  /** Path with its query string. */
  path: string;
  body: unknown;
}

export interface DriveAnswer {
  status: number;
  /** Absent = an empty body. */
  body?: unknown;
}

const CODE: Record<number, string> = {
  400: "validation",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
  500: "internal",
};

export function driveEnvelope(status: number, error = CODE[status] ?? "internal"): DriveAnswer {
  return { status, body: { error, message: `${error} (fake)`, requestId: "req-fake" } };
}

interface Failure {
  method: string;
  pattern: RegExp;
  status: number;
  error?: string;
  left: number;
}

export class FakeDrive {
  readonly nodes = new Map<string, NodeDto>();
  readonly trashed = new Map<string, NodeDto>();
  readonly calls: DriveCall[] = [];
  /** Per node: answers of `download-urls` that come back as `{ nodeId, error }`, first-in first-out. */
  readonly urlErrors = new Map<string, string[]>();
  filesOrigin: string;
  /**
   * The most items one page answers, whatever `limit` asked (a server may answer fewer): lets a
   * test have a second page without drawing hundreds of rows.
   */
  pageSize = Infinity;
  private failures: Failure[] = [];
  private nextNode = 9000;
  private nextToken = 1;

  constructor(nodes: NodeDto[] = [], filesOrigin = "http://files.localhost:3000") {
    this.filesOrigin = filesOrigin;
    this.add(...nodes);
  }

  add(...nodes: NodeDto[]): this {
    for (const node of nodes) this.nodes.set(node.id, node);
    return this;
  }

  /** Answer matching requests with this status instead — `times` times (default: always). */
  fail(method: string, pattern: RegExp, status: number, times = Infinity, error?: string): this {
    this.failures.push({ method, pattern, status, error, left: times });
    return this;
  }

  childrenOf(parentId: string | null): NodeDto[] {
    return Array.from(this.nodes.values()).filter((node) => node.parentId === parentId);
  }

  /** Requests made so far to paths (without the query) matching `pattern`. */
  callsTo(method: string, pattern: RegExp): DriveCall[] {
    return this.calls.filter(
      (call) => call.method === method && pattern.test(new URL(call.path, "http://app.invalid").pathname),
    );
  }

  private url(kind: "d" | "t", id: string): string {
    return `${this.filesOrigin}/${kind}/${id}/token-${this.nextToken++}`;
  }

  private taken(parentId: string | null, name: string, except?: string): boolean {
    return this.childrenOf(parentId).some(
      (node) => node.id !== except && node.name.toLowerCase() === name.toLowerCase(),
    );
  }

  private list(parentId: string | null, query: URLSearchParams): DriveAnswer {
    const sort = query.get("sort") ?? "name";
    const sign = query.get("dir") === "desc" ? -1 : 1;
    const kind = query.get("kind");
    const limit = Math.min(Number(query.get("limit") ?? 100), this.pageSize);
    const offset = Number(query.get("cursor") ?? 0);
    const value = (node: NodeDto): string | number =>
      sort === "size"
        ? node.size
        : sort === "updated"
          ? node.updatedAt
          : sort === "kind"
            ? node.ext
            : node.name;
    const all = this.childrenOf(parentId)
      .filter((node) => !kind || node.kind === kind)
      .sort((a, b) => {
        // Folders first, whatever the order.
        if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
        const [x, y] = [value(a), value(b)];
        const order =
          typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return (order || a.name.localeCompare(b.name)) * sign;
      });
    const items = all.slice(offset, offset + limit);
    const next = offset + limit < all.length ? String(offset + limit) : null;
    return { status: 200, body: NodePage.parse({ items, nextCursor: next }) };
  }

  private files(root: NodeDto, prefix: string): Array<{ node: NodeDto; path: string }> {
    if (root.kind === "file") return [{ node: root, path: prefix + root.name }];
    return this.childrenOf(root.id).flatMap((child) => this.files(child, `${prefix}${root.name}/`));
  }

  handle(call: DriveCall): DriveAnswer | null {
    const url = new URL(call.path, "http://app.invalid");
    const path = url.pathname;
    if (!path.startsWith("/api/nodes")) return null;
    this.calls.push(call);
    const failure = this.failures.find((f) => f.method === call.method && f.pattern.test(path) && f.left > 0);
    if (failure) {
      failure.left -= 1;
      return driveEnvelope(failure.status, failure.error);
    }
    const body = (call.body ?? {}) as Record<string, unknown>;
    const { method } = call;

    if (method === "GET" && path === "/api/nodes/root") return this.list(null, url.searchParams);
    if (method === "POST" && path === "/api/nodes/folder") {
      const parentId = (body.parentId as string | null) ?? null;
      const name = String(body.name);
      if (parentId !== null && !this.nodes.has(parentId)) return driveEnvelope(404);
      if (this.taken(parentId, name)) return driveEnvelope(409);
      const parent = parentId ? this.nodes.get(parentId)! : null;
      const node = folderNode(this.nextNode++, { parentId, name, role: parent?.role ?? "owner" });
      this.nodes.set(node.id, node);
      return { status: 200, body: NodeDto.parse(node) };
    }
    if (method === "GET" && path === "/api/nodes/scan-status") {
      // Each asked id that is a file here, as the node's GET would show it; the rest left out.
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      const items = ids.flatMap((id) => {
        const node = this.nodes.get(id);
        return node?.kind === "file" ? [node] : [];
      });
      return { status: 200, body: ScanStatusResponse.parse({ items }) };
    }
    if (method === "POST" && path === "/api/nodes/zip-manifest") {
      const ids = (body.nodeIds as string[]) ?? [];
      const found = ids.flatMap((id) => (this.nodes.has(id) ? this.files(this.nodes.get(id)!, "") : []));
      const reason = (node: NodeDto) =>
        node.scanStatus === "pending"
          ? "scan_pending"
          : node.scanStatus === "skipped" || node.scanStatus === "error"
            ? "unscanned"
            : "scan_blocked";
      const clean = found.filter(({ node }) => node.scanStatus === "clean");
      return {
        status: 200,
        body: ZipManifest.parse({
          entries: clean.map(({ node, path: entryPath }) => ({
            nodeId: node.id,
            path: entryPath,
            size: node.size,
            etag: node.etag,
            modifiedAt: node.updatedAt,
          })),
          totalBytes: clean.reduce((sum, { node }) => sum + node.size, 0),
          skipped: found
            .filter(({ node }) => node.scanStatus !== "clean")
            .map(({ node, path: entryPath }) => ({ nodeId: node.id, path: entryPath, reason: reason(node) })),
          truncated: false,
        }),
      };
    }
    if (method === "POST" && path === "/api/nodes/download-urls") {
      const ids = (body.nodeIds as string[]) ?? [];
      return {
        status: 200,
        body: BatchDownloadUrlsResponse.parse({
          items: ids.map((id) => {
            const error = this.urlErrors.get(id)?.shift();
            if (error) return { nodeId: id, error };
            if (!this.nodes.has(id)) return { nodeId: id, error: "not_found" };
            return { nodeId: id, url: this.url("d", id), expiresAt: AT };
          }),
        }),
      };
    }

    const match = /^\/api\/nodes\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
    if (!match) return driveEnvelope(404);
    const id = decodeURIComponent(match[1]!);
    const action = match[2] ?? "";
    if (method === "POST" && action === "restore") {
      const node = this.trashed.get(id);
      if (!node) return driveEnvelope(404);
      this.trashed.delete(id);
      // Back where it was — at the top level when its folder is gone, renamed when the name is taken.
      const parentId = node.parentId !== null && this.nodes.has(node.parentId) ? node.parentId : null;
      const name = this.taken(parentId, node.name) ? `${node.name} (restored)` : node.name;
      const restored = { ...node, parentId, name };
      this.nodes.set(id, restored);
      return { status: 200, body: RestoreNodeResponse.parse(restored) };
    }
    const node = this.nodes.get(id);
    if (!node) return driveEnvelope(404);

    if (method === "GET" && action === "children") return this.list(id, url.searchParams);
    if (method === "GET" && action === "") {
      const breadcrumbs: Array<{ id: string; name: string }> = [];
      for (let at = node.parentId; at !== null && this.nodes.has(at); at = this.nodes.get(at)!.parentId) {
        breadcrumbs.unshift({ id: at, name: this.nodes.get(at)!.name });
      }
      return { status: 200, body: NodeDetailDto.parse({ node, breadcrumbs }) };
    }
    if (method === "PATCH" && action === "") {
      const next = { ...node };
      if (typeof body.name === "string") {
        if (this.taken(node.parentId, body.name, id)) return driveEnvelope(409);
        next.name = body.name;
      }
      if (typeof body.starred === "boolean") next.starred = body.starred;
      this.nodes.set(id, next);
      return { status: 200, body: NodeDto.parse(next) };
    }
    if (method === "POST" && action === "move") {
      const parentId = (body.parentId as string | null) ?? null;
      if (parentId !== null && this.nodes.get(parentId)?.kind !== "folder") return driveEnvelope(404);
      if (parentId === id || this.taken(parentId, node.name, id)) return driveEnvelope(409);
      const moved = { ...node, parentId };
      this.nodes.set(id, moved);
      return { status: 200, body: NodeDto.parse(moved) };
    }
    if (method === "POST" && action === "trash") {
      this.nodes.delete(id);
      this.trashed.set(id, node);
      return {
        status: 200,
        body: TrashNodeResponse.parse({ ...node, deletedAt: AT, purgeAfter: "2026-11-01T12:00:00.000Z" }),
      };
    }
    if (method === "POST" && action === "download-url") {
      if (node.kind !== "file") return driveEnvelope(404);
      if (node.scanStatus === "pending") return driveEnvelope(409, "scan_pending");
      if (node.scanStatus === "infected" || node.scanStatus === "under_review")
        return driveEnvelope(403, "scan_blocked");
      const unscanned = node.scanStatus !== "clean";
      if (unscanned && node.role !== "owner") return driveEnvelope(403, "scan_blocked");
      return {
        status: 200,
        body: DownloadUrlResponse.parse({
          url: this.url("d", id),
          expiresAt: AT,
          ...(unscanned ? { warning: "unscanned" } : {}),
        }),
      };
    }
    if (method === "GET" && action === "thumb-url") {
      // A thumbnail can legitimately be missing.
      if (!node.thumb) return driveEnvelope(404);
      return { status: 200, body: ThumbUrlResponse.parse({ url: this.url("t", id), expiresAt: AT }) };
    }
    if (method === "POST" && action === "rescan") {
      if (node.scanStatus !== "error" && node.scanStatus !== "skipped") return driveEnvelope(409);
      this.nodes.set(id, { ...node, scanStatus: "pending", scanReason: null });
      return { status: 202 };
    }
    return driveEnvelope(404);
  }
}

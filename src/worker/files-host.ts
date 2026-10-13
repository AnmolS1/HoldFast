// The Hono app of the files host (FILES_ORIGIN): the only code path that hands user bytes to a
// browser.
//
//   GET|HEAD /d/<nodeId>/<token>          token kind `download` → an attachment
//   GET|HEAD /i/<nodeId>/<token>          token kind `inline`   → inline media, or an attachment
//                                         for the types a viewer fetches (PDF, small text)
//   GET|HEAD /t/<nodeId>/<size>/<token>   token kind `thumb`    → a cached WebP thumbnail
//   OPTIONS  (any path)                   the preflight, for the app origin only
//   anything else                         404
//
// What must stay true: never a cookie, never `env.ASSETS` (no HTML, no SPA shell), never a JSON
// error envelope — every failure is a short plain-text body carrying the error's message, never
// its code — and the fixed header set of middleware/security-headers.ts on every response.
//
// A VALID TOKEN IS NOT YET ACCESS. Every request is re-checked against the database: fresh reads
// in this request, never a session, never a cache. `gates` below holds the checks in the order
// they are answered; its row ids (`2`, `3a` … `6`) are the ones the task's table and the tests
// use. Gate 5 — the daily ceilings — CHARGES, so it comes last: after the object store has been
// asked and the preconditions are settled, immediately before the first byte.
//
// HTTP SEMANTICS ARE DONE HERE. The object store throws on an unsatisfiable range, ignores
// `If-Range` and answers a failed precondition with an object that says neither 304 nor 412. So
// `Range` is parsed from the size in the database before the store is asked, the store gets
// parsed forms only (never the request's headers), and `If-Range` is compared here.
//
// NOTHING IS BUFFERED, AND WHAT IS NOT SENT IS GIVEN BACK. The body is piped through a counting
// pass-through; when the stream ends — completed, cancelled or failed — the bytes that were
// charged and not sent are refunded on every ledger (`settle`). No URL, `Referer` or token is
// ever logged here.

import { canonicalRequest, isHeadRequest, requestPath } from "./middleware/canonical";
import { Hono, type Context } from "hono";
import { getById as linkById, logAccess } from "./db/queries/links";
import { accountOf, type ServeAccount } from "./db/queries/files-host";
import { getNode, touchAccessed } from "./db/queries/nodes";
import { effectiveHidden, effectiveRole, effectiveTrashed, isDescendantOrSelf } from "./db/queries/tree";
import { userState, type UserState } from "./db/queries/users";
import type { Node, ShareLink } from "./db/schema";
import { rateLimitByIp } from "./middleware/rate-limit";
import { requestContext } from "./middleware/request-context";
import { filesHostHeaders } from "./middleware/security-headers";
import { HEADER_WARNING, THUMB_SIZES, type ThumbSize } from "../shared/constants";
import type { ErrorCode } from "../shared/errors";
import { now } from "./services/clock";
import { AppError, handlePlainError } from "./services/errors";
import { dayUTC, ipHashDaily } from "./services/ip-hash";
import { recordServe, settleServe, type Serve, type ServeCharge } from "./services/ledger";
import { metric } from "./services/metrics";
import { contentDisposition, inlineKindAllowed, serveType, thumbEligible } from "./services/mime";
import {
  coreOf,
  db,
  defer,
  deps,
  DRAIN_DEADLINE_MS,
  keys,
  registerCoreDeps,
  runBackground,
  settings,
  type AppEnv,
  type CoreDeps,
} from "./services/request-context";
import { storage, thumbKey, type GetResult } from "./services/storage";
import { makeThumbnail, THUMB_TYPE } from "./services/thumbnails";
import { linkPwv, verifyDownloadToken, type DownloadClaims, type TokenKind } from "./services/tokens";

const TEXT = { "content-type": "text/plain; charset=utf-8" };
const EXPOSED = "Content-Length, Content-Range, ETag, Accept-Ranges, X-Holdfast-Warning";

type Ctx = Context<AppEnv>;
type LinkOutcome = Parameters<typeof logAccess>[1]["outcome"];

// ── the path ────────────────────────────────────────────────────────────────────────────────

type Target = { nodeId: string; token: string; size?: number };

/** `/d/<id>/<token>`, `/i/<id>/<token>`, `/t/<id>/<size>/<token>` — or null for any other shape. */
function targetOf(kind: TokenKind, path: string): Target | null {
  const parts = path.split("/").slice(2);
  if (kind === "thumb") {
    const [nodeId, size, token] = parts;
    if (parts.length !== 3 || !nodeId || !token || !size || !/^\d{1,5}$/.test(size)) return null;
    return { nodeId, token, size: Number(size) };
  }
  const [nodeId, token] = parts;
  if (parts.length !== 2 || !nodeId || !token) return null;
  return { nodeId, token };
}

// ── the gates ───────────────────────────────────────────────────────────────────────────────

type Refusal = {
  ok: false;
  /** The row of the gate table that refused. */
  gate: string;
  code: ErrorCode;
  /** A link subject's refusal, for `link_access_log` (the response never says why). */
  log?: { linkId: string; outcome: LinkOutcome };
};

type Passed = {
  ok: true;
  node: Node & { r2Key: string; versionId: string };
  /** The file's owner: the account its links' ceilings and its thumbnails' transforms count on. */
  owner: ServeAccount;
  /** The token's subject: the user (`st: "u"`) or the link (`st: "l"`). */
  subject: { st: "u"; account: ServeAccount } | { st: "l"; link: ShareLink };
  /** `skipped` / `error`: served to its owner as a download, with the warning header. */
  unscanned: boolean;
};

const refuse = (gate: string, code: ErrorCode, log?: Refusal["log"]): Refusal => ({
  ok: false,
  gate,
  code,
  log,
});

const blocked = (state: UserState | null) => state === null || state.banned || state.suspendedAt !== null;

/** Gates 3b–3e: the scan state. A link subject learns nothing but "still being scanned". */
function scanGate(node: Node, claims: DownloadClaims, kind: TokenKind): Refusal | "unscanned" | null {
  const linkLog = claims.st === "l" ? { linkId: claims.sub, outcome: "denied_scan" as const } : undefined;
  const hidden = (gate: string) =>
    claims.st === "l" ? refuse(gate, "not_found", linkLog) : refuse(gate, "scan_blocked");
  switch (node.scanStatus) {
    case "clean":
      return null;
    case "suspected_csam":
      return refuse("3b", "not_found", linkLog);
    case "pending":
      return refuse("3c", "scan_pending", linkLog);
    case "infected":
    case "under_review":
      return hidden("3d");
    case "skipped":
    case "error":
      // Never scanned: only its owner may take it, and only as a download.
      if (claims.st === "u" && claims.sub === node.ownerId && kind === "download") return "unscanned";
      return hidden("3e");
    default:
      return hidden("3d");
  }
}

/** Gate 6: what this kind of URL may serve — decided from the DETECTED type alone. */
function kindGate(node: Node, kind: TokenKind): Refusal | null {
  if (kind === "inline" && !inlineKindAllowed(node)) return refuse("6", "forbidden");
  if (kind === "thumb" && !thumbEligible(node)) return refuse("6", "not_found");
  return null;
}

/**
 * Gates 2–4 and 6, in the order they are answered; the first failure decides. (Gate 0 is the
 * rate limiter, 1a–1d the token — both before this — and gate 5 charges, after the store was
 * asked.) The order depends on who the token was minted for:
 *
 *   a user (`st: "u"`)   2 → 3a–3e → 4a–4d → 6
 *   a link (`st: "l"`)   2 → 4a, 4b, 4e–4h, 4k, 4i, 4j → 3a–3e → 6
 *
 * For a link, LINK STATE COMES BEFORE NODE STATE — a paused link to a reported or trashed file
 * answers "paused", as the public API does — so "not in the trash" (part of gate 2 for a user)
 * is answered with the node state, after the link's rows.
 */
async function gates(c: Ctx, claims: DownloadClaims, kind: TokenKind): Promise<Passed | Refusal> {
  const handle = db(c);
  const found = await getNode(handle, claims.n);

  // 2 — the node exists, is a file, and is still the version the token was minted for.
  if (!found || found.kind !== "file" || !found.r2Key || !found.versionId || found.versionId !== claims.ver) {
    return refuse("2", "not_found");
  }
  const node = found as Passed["node"];
  const ownedBySubject = claims.st === "u" && claims.sub === node.ownerId;

  if (claims.st === "u") {
    if (await effectiveTrashed(handle, node.id)) return refuse("2", "not_found");
    // 3a — taken down, itself or by ANY ancestor (and the lock of 3b): as if it did not exist.
    if (await effectiveHidden(handle, node.id)) return refuse("3a", "not_found");
    const scan = scanGate(node, claims, kind);
    if (scan && scan !== "unscanned") return scan;

    // 4a — the owner: suspension and a ban block everyone, the owner included.
    const ownerState = await userState(handle, node.ownerId);
    if (blocked(ownerState)) return refuse("4a", "forbidden");
    // 4b — inside the deletion window nothing is served to OTHERS; the owner keeps access.
    if (ownerState?.deleteScheduledAt && !ownedBySubject) return refuse("4b", "forbidden");
    // 4c — the subject itself (its own scheduled deletion is no reason to refuse).
    if (!ownedBySubject && blocked(await userState(handle, claims.sub))) return refuse("4c", "forbidden");
    // 4d — still at least a viewer. An avatar's thumbnail is the exception: who may see an
    // avatar is decided where its URL is minted.
    const avatarThumb = node.system === "avatar" && kind === "thumb";
    if (!avatarThumb && (await effectiveRole(handle, claims.sub, node.id)) === null) {
      return refuse("4d", "not_found");
    }
    const policy = kindGate(node, kind);
    if (policy) return policy;

    const owner = await accountOf(handle, node.ownerId);
    const account = ownedBySubject ? owner : await accountOf(handle, claims.sub);
    if (!owner || !account) return refuse("4c", "forbidden");
    return { ok: true, node, owner, subject: { st: "u", account }, unscanned: scan === "unscanned" };
  }

  // ── a link ──
  const paused = (gate: string, outcome: LinkOutcome = "denied_paused") =>
    refuse(gate, "link_paused", { linkId: claims.sub, outcome });
  // 4a, 4b — the owner's state. A link is "other people": the deletion window blocks it too.
  const ownerState = await userState(handle, node.ownerId);
  if (blocked(ownerState)) return paused("4a", "denied_owner");
  if (ownerState?.deleteScheduledAt) return paused("4b", "denied_owner");
  // 4e — the kill switch.
  if (!(await settings(c)).linksEnabled) return paused("4e");
  // 4f — the link row, read now.
  const link = await linkById(handle, claims.sub);
  if (!link) return refuse("4f", "not_found");
  if (link.revokedAt !== null)
    return refuse("4f", "link_expired", { linkId: link.id, outcome: "denied_expired" });
  // 4g — locked, or paused for ANY reason in its set.
  if (link.lockedByAdmin || link.pausedAt !== null || link.pauseReasons.length > 0) return paused("4g");
  // 4h
  if (link.expiresAt !== null && link.expiresAt.getTime() <= now(c).getTime()) {
    return refuse("4h", "link_expired", { linkId: link.id, outcome: "denied_expired" });
  }
  // 4k — the token was minted under the link's CURRENT password version, for every kind.
  if (claims.pwv !== (await linkPwv(link.passwordHash))) return refuse("4k", "invalid_token");
  // 4i — the link covers the node: it is the link's node or lies under it, and nothing on the
  // way up — the link's own root and what is above it included — is in the trash or taken down.
  // (This is also gate 2's "not in the trash" and gate 3a for a link: the same 404.)
  if (!(await isDescendantOrSelf(handle, node.id, link.nodeId))) return refuse("4i", "not_found");
  if (await effectiveTrashed(handle, node.id)) return refuse("2", "not_found");
  if (await effectiveHidden(handle, node.id)) {
    return refuse("3a", "not_found", { linkId: link.id, outcome: "denied_scan" });
  }
  // 4j
  if (kind !== "download" && !link.allowPreview) return refuse("4j", "forbidden");
  const scan = scanGate(node, claims, kind);
  if (scan && scan !== "unscanned") return scan;
  const policy = kindGate(node, kind);
  if (policy) return policy;

  const owner = await accountOf(handle, node.ownerId);
  if (!owner) return refuse("4a", "link_paused");
  return { ok: true, node, owner, subject: { st: "l", link }, unscanned: false };
}

// ── Range and the preconditions ─────────────────────────────────────────────────────────────

type Range = { r2: R2Range; offset: number; length: number };

/**
 * Exactly one range of the forms `bytes=a-b`, `bytes=a-`, `bytes=-n`, against the size in the
 * database. "unsatisfiable": it selects nothing (a start at or past the end, `bytes=-0`).
 * Null: no range — also for a multi-range, a malformed one or another unit, which are answered
 * with the whole object. An end past the last byte and a suffix longer than the object are cut.
 */
export function parseRange(header: string | undefined, size: number): Range | "unsatisfiable" | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) return null;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { r2: { suffix: length }, offset: size - length, length };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (last !== "" && Number(last) < start) return null;
  if (start >= size) return "unsatisfiable";
  const length = end - start + 1;
  return { r2: { offset: start, length }, offset: start, length };
}

type Tags = { any: boolean; tags: string[] };

/**
 * The entity tags of an `If-Match` / `If-None-Match` header, bare. A member that is not a quoted
 * (or weak) tag is dropped; a header with nothing usable is no condition at all (null).
 */
function entityTags(header: string | undefined): Tags | null {
  if (header === undefined) return null;
  const tags: string[] = [];
  let any = false;
  for (const member of header.split(",")) {
    const text = member.trim();
    if (text === "*") any = true;
    const quoted = /^(?:W\/)?"([^"]*)"$/.exec(text);
    if (quoted?.[1]) tags.push(quoted[1]);
  }
  return any || tags.length > 0 ? { any, tags } : null;
}

function httpDate(header: string | undefined): Date | null {
  if (header === undefined) return null;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : new Date(at);
}

type Conditions = {
  match: Tags | null;
  noneMatch: Tags | null;
  /** Read only when the stronger header of its pair is absent (RFC 9110 §13.2.2). */
  unmodifiedSince: Date | null;
  modifiedSince: Date | null;
};

function conditionsOf(c: Ctx): Conditions {
  const match = entityTags(c.req.header("if-match"));
  const noneMatch = entityTags(c.req.header("if-none-match"));
  return {
    match,
    noneMatch,
    unmodifiedSince: match ? null : httpDate(c.req.header("if-unmodified-since")),
    modifiedSince: noneMatch ? null : httpDate(c.req.header("if-modified-since")),
  };
}

const seconds = (at: Date) => Math.floor(at.getTime() / 1000);

/** What the preconditions say about an object whose metadata is in hand. */
function evaluate(meta: { etag: string; uploaded: Date }, conditions: Conditions): 200 | 304 | 412 {
  const { match, noneMatch, unmodifiedSince, modifiedSince } = conditions;
  if (match && !match.any && !match.tags.includes(meta.etag)) return 412;
  if (unmodifiedSince && seconds(meta.uploaded) > seconds(unmodifiedSince)) return 412;
  if (noneMatch && (noneMatch.any || noneMatch.tags.includes(meta.etag))) return 304;
  if (modifiedSince && seconds(meta.uploaded) <= seconds(modifiedSince)) return 304;
  return 200;
}

/**
 * The store's condition, from parsed forms only. `*` never goes to the store: `If-Match: *`
 * holds (the node exists by now) and `If-None-Match: *` is answered before the store is asked.
 */
function storeCondition(conditions: Conditions): R2Conditional | undefined {
  const out: R2Conditional = {};
  const { match, noneMatch, unmodifiedSince, modifiedSince } = conditions;
  // A list is passed as a list: the storage service takes one, the binding's type names one tag.
  const list = (tags: string[]) => (tags.length === 1 ? tags[0]! : tags) as string;
  if (match && !match.any && match.tags.length > 0) out.etagMatches = list(match.tags);
  if (noneMatch && !noneMatch.any && noneMatch.tags.length > 0) out.etagDoesNotMatch = list(noneMatch.tags);
  if (unmodifiedSince) out.uploadedBefore = unmodifiedSince;
  if (modifiedSince) out.uploadedAfter = modifiedSince;
  if (unmodifiedSince || modifiedSince) out.secondsGranularity = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * `If-Range`: does the validator the client holds still name this object? A strong entity tag
 * must equal the object's; a date must be its upload second. Anything else — a weak tag, an
 * unquoted one, a date that does not parse — does not hold, and the whole object is sent.
 */
function ifRangeHolds(header: string, meta: { httpEtag: string; uploaded: Date }): boolean {
  const value = header.trim();
  if (value.startsWith('"')) return value === meta.httpEtag;
  if (value.startsWith("W/")) return false;
  const date = httpDate(value);
  return date !== null && seconds(date) === seconds(meta.uploaded);
}

// ── responses ───────────────────────────────────────────────────────────────────────────────

type Meta = { httpEtag: string; uploaded: Date };
type Shown = { type: string; disposition: string; unscanned: boolean };

/** The headers every answer about an object carries (the fixed set is the middleware's). */
function objectHeaders(meta: Meta | null, shown: Shown): Headers {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": shown.type,
    "Content-Disposition": shown.disposition,
    "Access-Control-Expose-Headers": EXPOSED,
  });
  if (meta) {
    headers.set("ETag", meta.httpEtag);
    headers.set("Last-Modified", meta.uploaded.toUTCString());
  }
  if (shown.unscanned) headers.set(HEADER_WARNING, "unscanned");
  return headers;
}

function notModified(meta: Meta): Response {
  const headers = new Headers({ ETag: meta.httpEtag, "Last-Modified": meta.uploaded.toUTCString() });
  headers.set("Access-Control-Expose-Headers", EXPOSED);
  return new Response(null, { status: 304, headers });
}

const preconditionFailed = () => new Response("Precondition failed.\n", { status: 412, headers: TEXT });

function unsatisfiable(size: number): Response {
  return new Response("The requested range is not satisfiable.\n", {
    status: 416,
    headers: { ...TEXT, "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
  });
}

/** Where in an object the body that was read lies. `range` is always present on a read. */
function windowOf(object: { size: number; range?: R2Range }): { offset: number; length: number } {
  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range?.suffix !== undefined) {
    const length = Math.min(range.suffix, object.size);
    return { offset: object.size - length, length };
  }
  const offset = range?.offset ?? 0;
  return { offset, length: range?.length ?? object.size - offset };
}

// ── accounting ──────────────────────────────────────────────────────────────────────────────

/**
 * How long after the handler returned the settle still runs on the request's own database
 * client: half the drain deadline, so the client is certainly still open. A stream that ends
 * later is settled in a background context of its own.
 */
const settleInRequestMs = (c: Ctx) =>
  Math.floor((coreOf(c).limits?.drainDeadlineMs ?? DRAIN_DEADLINE_MS) / 2);

/**
 * Arranges the ONE settle of a response's charge and returns the function to call when its
 * stream has ended — completed, cancelled or failed — with the body bytes that were sent.
 * It settles exactly once, however often and however late it is called:
 *   in time   through `defer`, on the request's client (registered here, before the handler
 *             returns — never from inside the stream);
 *   late      the request's client is closed by then: `runBackground` (a pool of its own),
 *             handed to `waitUntil` at the moment the stream ends.
 * A settle that fails leaves the reservation in place until the day rolls over — the ledger
 * over-counts, it never under-counts — and is counted.
 */
function settleLater(c: Ctx, charge: ServeCharge): (sent: number) => void {
  let state: "open" | "in-time" | "late" | "done" = "open";
  let inTime!: (sent: number | null) => void;
  const early = new Promise<number | null>((resolve) => (inTime = resolve));
  const timer = setTimeout(() => {
    if (state !== "open") return;
    state = "late";
    inTime(null);
  }, settleInRequestMs(c));
  const failed = () => {
    metric("download", { outcome: "settle_failed" });
    console.warn("files host: a served response was not settled");
  };
  const source = deps(c);
  defer(
    c,
    early.then((sent) => (sent === null ? undefined : settleServe(source, charge, sent))).catch(failed),
  );
  const { env, executionCtx } = c;
  const core = coreOf(c);
  return (sent) => {
    if (state === "open") {
      state = "in-time";
      clearTimeout(timer);
      inTime(sent);
    } else if (state === "late") {
      state = "done";
      // The request's own drain is over: `defer` would be refused. The background context opens,
      // drains and closes a pool of its own, so nothing request-scoped is held by this promise.
      // eslint-disable-next-line no-restricted-syntax -- not database work on the request's client
      executionCtx.waitUntil(
        runBackground(env, executionCtx, (bg) => settleServe(bg, charge, sent), core).catch(failed),
      );
    }
  };
}

/** The body, counted: `ended` is called once with the bytes that passed, whatever ended it. */
function counted(body: ReadableStream<Uint8Array>, total: number, ended: (sent: number) => void) {
  let sent = 0;
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    ended(sent);
  };
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush: end,
  });
  // A reader that goes away cancels the readable side, which fails this pipe: that is an end too.
  body.pipeTo(counter.writable).then(end, end);
  // The length is known, so the response carries it instead of being chunked.
  return counter.readable.pipeThrough(new FixedLengthStream(total));
}

async function ipSubject(c: Ctx): Promise<string> {
  return ipHashDaily(keys(c), c.get("ip"), dayUTC(now(c)));
}

/** A refusal's row in `link_access_log`, after the response. The response never says why. */
function logDenied(c: Ctx, nodeId: string | null, log: NonNullable<Refusal["log"]>): void {
  const country = (c.req.raw as { cf?: { country?: unknown } }).cf?.country;
  const write = async () =>
    logAccess(db(c), {
      linkId: log.linkId,
      nodeId,
      outcome: log.outcome,
      ipHashDaily: await ipSubject(c),
      country: typeof country === "string" ? country : null,
      uaHash: null,
    });
  defer(
    c,
    write().catch(() => {}),
  );
}

/** Gate 5: charges the body this response will send. Throws `429` — after logging a link's. */
async function charge(c: Ctx, passed: Passed, bytes: number): Promise<ServeCharge> {
  const ip = bytes === 0 ? "" : await ipSubject(c);
  const serve: Serve =
    passed.subject.st === "u"
      ? { st: "u", sub: passed.subject.account.id, account: passed.subject.account, bytes, ip }
      : {
          st: "l",
          sub: passed.subject.link.id,
          owner: { id: passed.owner.id, account: passed.owner },
          bytes,
          ip,
        };
  try {
    return await recordServe(c, serve);
  } catch (error) {
    if (passed.subject.st === "l" && error instanceof AppError && error.code === "ceiling_exceeded") {
      logDenied(c, passed.node.id, { linkId: passed.subject.link.id, outcome: "denied_cap" });
    }
    throw error;
  }
}

/** A streamed body: charged first (the open body is cancelled when the charge is refused). */
async function streamed(
  c: Ctx,
  passed: Passed,
  body: ReadableStream<Uint8Array>,
  bytes: number,
): Promise<ReadableStream<Uint8Array> | null> {
  let charged: ServeCharge;
  try {
    charged = await charge(c, passed, bytes);
  } catch (error) {
    await body.cancel().catch(() => {});
    throw error;
  }
  if (bytes === 0) {
    await body.cancel().catch(() => {});
    return null;
  }
  return counted(body, bytes, settleLater(c, charged));
}

// ── serving an object ───────────────────────────────────────────────────────────────────────

/**
 * Answers from one stored object: the file itself, or a cached thumbnail. `size` is the length
 * the range is judged by — the database's for a file. Null when the store has no such object
 * (a thumbnail that was never made; for a file the caller answers 404).
 */
async function serveObject(
  c: Ctx,
  passed: Passed,
  key: string,
  size: number | null,
  shown: Shown,
): Promise<Response | null> {
  const store = storage(c.env);
  const conditions = conditionsOf(c);
  const head = isHeadRequest(c);
  const rangeHeader = c.req.header("range");
  const ifRange = c.req.header("if-range");

  // A HEAD, and `If-None-Match: *` (which the store is never asked about): the object's metadata
  // only — no body is opened and nothing is charged.
  if (head || conditions.noneMatch?.any) {
    const meta = await store.head(key);
    if (!meta) return null;
    const range = parseRange(rangeHeader, size ?? meta.size);
    if (range === "unsatisfiable") return unsatisfiable(size ?? meta.size);
    const verdict = evaluate(meta, conditions);
    if (verdict === 304) return notModified(meta);
    if (verdict === 412) return preconditionFailed();
    const headers = objectHeaders(meta, shown);
    const partial = range !== null && (ifRange === undefined || ifRangeHolds(ifRange, meta));
    if (partial && range) {
      headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`);
    }
    headers.set("Content-Length", String(partial && range ? range.length : meta.size));
    return new Response(null, { status: partial ? 206 : 200, headers });
  }

  // 1 — the range, from the size in hand, before the store is asked.
  const range = size === null ? null : parseRange(rangeHeader, size);
  if (range === "unsatisfiable") return unsatisfiable(size ?? 0);

  // 2, 3 — the store, with parsed forms only.
  let found: GetResult = await store.get(key, {
    ...(range ? { range: range.r2 } : {}),
    ...(storeCondition(conditions) ? { onlyIf: storeCondition(conditions) } : {}),
  });
  if (found === null) return null;
  if (found.kind === "unsatisfiable_range") return unsatisfiable(found.size);
  if (found.kind === "precondition_failed") {
    // 4 — the store does not say which condition failed: decided from what was sent.
    const verdict = evaluate(found.meta, conditions);
    if (verdict === 412) return preconditionFailed();
    if (verdict === 304) return notModified(found.meta);
    return conditions.noneMatch || conditions.modifiedSince ? notModified(found.meta) : preconditionFailed();
  }

  // 5 — `If-Range`: a validator that no longer names this object gets the whole of it.
  let partial = range !== null;
  if (range && ifRange !== undefined && !ifRangeHolds(ifRange, found.object)) {
    await found.object.body.cancel().catch(() => {});
    found = await store.get(key);
    if (found === null) return null;
    if (found.kind !== "body") return preconditionFailed();
    partial = false;
  }

  // 6 — the status and the lengths come from what the store read, never from the request.
  const object = found.object;
  const window = windowOf(object);
  const headers = objectHeaders(object, shown);
  if (partial) {
    headers.set(
      "Content-Range",
      `bytes ${window.offset}-${window.offset + window.length - 1}/${object.size}`,
    );
  }
  headers.set("Content-Length", String(window.length));
  const body = await streamed(c, passed, object.body, window.length);
  return new Response(body, { status: partial ? 206 : 200, headers });
}

function outcomeOf(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

async function serveFile(c: Ctx, passed: Passed, kind: "download" | "inline"): Promise<Response> {
  const { node } = passed;
  const type = serveType(node.mimeSniffed, node.name);
  const shown: Shown = {
    type,
    disposition: contentDisposition(kind, node.name, type),
    unscanned: passed.unscanned,
  };
  const response = await serveObject(c, passed, node.r2Key, node.size, shown);
  if (!response) throw new AppError("not_found");
  // "Files I opened": the owner's own download or view, at most one write per ten minutes.
  const opened = response.status === 200 || response.status === 206;
  if (
    opened &&
    !isHeadRequest(c) &&
    passed.subject.st === "u" &&
    passed.subject.account.id === node.ownerId
  ) {
    defer(
      c,
      touchAccessed(db(c), node.id).catch(() => {}),
    );
  }
  metric("download", { kind, outcome: outcomeOf(response.status) });
  return response;
}

async function serveThumb(c: Ctx, passed: Passed, size: ThumbSize): Promise<Response> {
  const { node } = passed;
  const shown: Shown = {
    type: THUMB_TYPE,
    disposition: contentDisposition("thumb", node.name, THUMB_TYPE),
    unscanned: false,
  };
  const cached = await serveObject(c, passed, thumbKey(node.id, node.versionId, size), null, shown);
  if (cached) {
    metric("thumb", { kind: "thumb", outcome: outcomeOf(cached.status), reason: "hit" });
    return cached;
  }

  // A HEAD makes nothing: no transform, no unit, no object written.
  if (isHeadRequest(c)) throw new AppError("not_found");
  // A miss: one transform, one attempt. Whatever goes wrong, the answer is the icon's 404.
  const made = await makeThumbnail(c, node, size, { id: passed.owner.id, account: passed.owner });
  if (!made.ok) {
    metric("thumb", { kind: "thumb", outcome: "error", reason: made.reason });
    throw new AppError("not_found");
  }
  const headers = objectHeaders(made.stored, shown);
  headers.set("Content-Length", String(made.buffer.byteLength));
  metric("thumb", { kind: "thumb", outcome: "2xx", reason: "miss" });
  const body = await streamed(c, passed, new Response(made.buffer).body!, made.buffer.byteLength);
  return new Response(body, { status: 200, headers });
}

// ── the routes ──────────────────────────────────────────────────────────────────────────────

function route(kind: TokenKind) {
  const name = kind === "thumb" ? "thumb" : "download";
  return async (c: Ctx): Promise<Response> => {
    // 1a–1d — one answer for every token that does not verify, and no database for any of them.
    const target = targetOf(kind, requestPath(c));
    let claims: DownloadClaims;
    try {
      if (!target) throw new AppError("invalid_token");
      claims = await verifyDownloadToken(keys(c), target.token, {
        kind,
        nodeId: target.nodeId,
        size: target.size,
      });
    } catch (error) {
      metric(name, { kind, outcome: "4xx", reason: "1" });
      throw error;
    }

    const result = await gates(c, claims, kind);
    if (!result.ok) {
      metric(name, { kind, outcome: "4xx", reason: result.gate });
      if (result.log) logDenied(c, claims.n, result.log);
      throw new AppError(result.code);
    }
    try {
      if (kind !== "thumb") return await serveFile(c, result, kind);
      // The token's size is the path's, and a token only ever carries a real one.
      const size = THUMB_SIZES.find((candidate) => candidate === target?.size);
      if (size === undefined) throw new AppError("invalid_token");
      return await serveThumb(c, result, size);
    } catch (error) {
      if (error instanceof AppError && error.code === "ceiling_exceeded") {
        metric(name, { kind, outcome: "4xx", reason: "5" });
      }
      throw error;
    }
  };
}

export function createFilesHost(core: CoreDeps): Hono<AppEnv> {
  registerCoreDeps(core);
  const app = new Hono<AppEnv>();
  app.onError(handlePlainError);
  app.notFound(() => new Response("Not found\n", { status: 404, headers: TEXT }));

  // First: one reading of the path and the method (middleware/canonical.ts).
  app.use("*", canonicalRequest("files"));
  app.use("*", requestContext(core));
  app.use("*", filesHostHeaders);
  app.use("*", rateLimitByIp("RL_FILES"));

  // CORS preflight: only the app origin may ask. Anything else gets the ordinary 404.
  app.options("*", (c) => {
    if (c.req.header("origin") !== c.env.APP_ORIGIN) return c.notFound();
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, If-None-Match, If-Range",
        "Access-Control-Max-Age": "600",
      },
    });
  });

  // Everything under a prefix reaches its route: a path that is not `<id>/<token>` is a token
  // that does not parse, and is answered as one.
  app.on(["GET", "HEAD"], "/d/*", route("download"));
  app.on(["GET", "HEAD"], "/i/*", route("inline"));
  app.on(["GET", "HEAD"], "/t/*", route("thumb"));

  return app;
}

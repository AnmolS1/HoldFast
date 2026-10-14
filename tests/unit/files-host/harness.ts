// Shared by the files-host tests. Runs inside workerd, against this checkout's local Postgres and
// the local object store.
//
// The app under test is the real one — `createFilesHost` over exactly what the Worker entry
// injects — driven directly, so a test chooses its own settings (never the shared `settings`
// table), its own vars and bindings (`env`: a `CEIL_*` value, a spying bucket, a mocked IMAGES)
// and can hold a response's body open. Postgres is shared by every test file of a run: every
// fixture has random ids, every assertion is about rows this file made.
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { ThumbSize } from "../../../src/shared/constants";
import type { Settings } from "../../../src/worker/db/queries/settings";
import {
  downloadLedger,
  linkAccessLog,
  nodes,
  shareLinks,
  user,
  type LedgerSubject,
  type Node,
  type ScanStatus,
} from "../../../src/worker/db/schema";
import { statementsSent, type Db } from "../../../src/worker/db/client";
import { createFilesHost } from "../../../src/worker/files-host";
import { dayUTC, ipHashDaily } from "../../../src/worker/services/ip-hash";
import { createKeys } from "../../../src/worker/services/keys";
import type { CoreDeps, DeferLimits } from "../../../src/worker/services/request-context";
import {
  linkPwv,
  mintDownloadToken,
  type DownloadClaims,
  type TokenKind,
} from "../../../src/worker/services/tokens";
import { TEST_APP_ORIGIN, TEST_FILES_ORIGIN } from "../../setup/test-vars";
import { BASE_SETTINGS, freshIp, makeLink, realCore, testDb } from "../auth/helpers";
import { makeFile, makeUser, putObject, rand } from "../services-core/helpers";

export { freshIp, linkById, makeLink, mailTo, testDb } from "../auth/helpers";
export {
  gate,
  makeFile,
  makeFolder,
  makeShare,
  makeUser,
  nodeById,
  putObject,
  rand,
} from "../services-core/helpers";

export const keys = createKeys(env.FILES_TOKEN_SECRET);

// ── requests ────────────────────────────────────────────────────────────────────────────────

export type Ctx = ExecutionContext & {
  pending: Promise<unknown>[];
  settle(): Promise<void>;
  /** Resolves when the next promise is handed to `waitUntil` — an event to wait for, not a time. */
  next(): Promise<void>;
};

export function newCtx(): Ctx {
  const pending: Promise<unknown>[] = [];
  const waiting: Array<() => void> = [];
  return {
    pending,
    next: () => new Promise<void>((resolve) => waiting.push(resolve)),
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
      for (const resolve of waiting.splice(0)) resolve();
    },
    passThroughOnException() {},
    props: {},
    async settle() {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
  } as unknown as Ctx;
}

export type AskOptions = {
  method?: string;
  headers?: Record<string, string>;
  /** Vars and bindings this request sees over the test environment's. */
  env?: Record<string, unknown>;
  /** Settings this request sees, over BASE_SETTINGS (`ceilings` overrides a `CEIL_*` value). */
  settings?: Settings;
  /** The client address. A fresh one per request unless given. */
  ip?: string;
  /** What `now(c)` answers for this request. */
  now?: Date;
  /** Overrides of the drain bounds (the settle's two paths). */
  limits?: Partial<DeferLimits>;
  /** The request's context, when the test must look at it WHILE the request runs. */
  ctx?: Ctx;
};

const allow = { limit: async () => ({ success: true }) };

/** How many database clients the requests of this file opened (a refused token must open none). */
export const opened = { clients: 0 };

function coreFor(options: AskOptions, handles: Db[] = []): CoreDeps {
  return {
    ...realCore,
    limits: options.limits,
    createDb: (...args) => {
      opened.clients += 1;
      const made = realCore.createDb(...args);
      handles.push(made.db);
      return made;
    },
    getSettings: async () => ({ ...BASE_SETTINGS, ...options.settings }),
  };
}

/**
 * One request to the files host. The response comes back UNREAD, with the context that holds its
 * deferred work: the caller reads or cancels the body FIRST and settles after (a settle before
 * that would wait for a stream nobody reads).
 */
export async function open(path: string, options: AskOptions = {}) {
  const ctx = options.ctx ?? newCtx();
  const headers = new Headers({ "cf-connecting-ip": options.ip ?? freshIp(), ...options.headers });
  if (options.now) headers.set("x-holdfast-test-now", options.now.toISOString());
  const request = new Request(`${TEST_FILES_ORIGIN}${path}`, { method: options.method ?? "GET", headers });
  const requestEnv = { ...env, RL_FILES: allow, ...options.env } as unknown as Env;
  const handles: Db[] = [];
  const response = await createFilesHost(coreFor(options, handles)).fetch(request, requestEnv, ctx);
  /** The statements this request has sent so far (its deferred work's too, once settled). */
  const statements = () => handles.reduce((sum, handle) => sum + statementsSent(handle), 0);
  return { response, ctx, answered: statements(), statements };
}

export type Answer = {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  text: string;
  /** Statements sent before the response was handed back — what its timing can show. */
  answered: number;
  /** Statements sent in all, deferred work included. */
  statements: number;
};

/** One request, its body read to the end, and everything it deferred done. */
export async function ask(path: string, options: AskOptions = {}): Promise<Answer> {
  const { response, ctx, answered, statements } = await open(path, options);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await ctx.settle();
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    text: new TextDecoder().decode(bytes.subarray(0, 512)),
    answered,
    statements: statements(),
  };
}

/** Reads `count` body bytes (or to the end, if it comes first), then cancels the rest. */
export async function readThenCancel(response: Response, count: number): Promise<number> {
  const reader = response.body!.getReader();
  let read = 0;
  while (read < count) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
  }
  await reader.cancel();
  return read;
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────

/** `length` bytes that are different at every offset a range test looks at. */
export function pattern(length: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 7 + seed + (i >> 8)) % 251;
  return bytes;
}

/**
 * An account that is NOT new (no new-account factor on its ceilings) and has no quota for a
 * ceiling to scale with: a `CEIL_*` value a test sets is the limit that applies.
 */
export function makeAccount(overrides: Partial<typeof user.$inferInsert> = {}) {
  return makeUser({ createdAt: new Date("2024-01-01T00:00:00Z"), quotaBytes: 0, ...overrides });
}

export type StoredFile = { node: Node & { r2Key: string; versionId: string }; bytes: Uint8Array };

/** A clean file node with its object in the store. `content: null` stores nothing. */
export async function storedFile(
  ownerId: string,
  options: {
    parentId?: string | null;
    name?: string;
    mime?: string | null;
    content?: Uint8Array | null;
    scanStatus?: ScanStatus;
    node?: Partial<typeof nodes.$inferInsert>;
  } = {},
): Promise<StoredFile> {
  const bytes = options.content === undefined ? pattern(1000) : (options.content ?? new Uint8Array(0));
  const node = await makeFile(ownerId, options.parentId ?? null, {
    name: options.name ?? `file-${rand()}.bin`,
    size: bytes.byteLength,
    mimeSniffed: options.mime === undefined ? "application/octet-stream" : options.mime,
    scanStatus: options.scanStatus ?? "clean",
    ...options.node,
  });
  if (options.content !== null) await putObject(node.r2Key!, bytes);
  return { node: node as StoredFile["node"], bytes };
}

export async function updateNode(id: string, set: Partial<typeof nodes.$inferInsert>) {
  await testDb().update(nodes).set(set).where(eq(nodes.id, id));
}
export async function updateUser(id: string, set: Partial<typeof user.$inferInsert>) {
  await testDb().update(user).set(set).where(eq(user.id, id));
}
export async function updateLink(id: string, set: Partial<typeof shareLinks.$inferInsert>) {
  await testDb().update(shareLinks).set(set).where(eq(shareLinks.id, id));
}

/** A live link on `nodeId`, made by its owner. */
export async function linkOn(
  nodeId: string,
  ownerId: string,
  set: Partial<typeof shareLinks.$inferInsert> = {},
) {
  const link = await makeLink(nodeId, ownerId);
  if (Object.keys(set).length === 0) return link;
  const [row] = await testDb().update(shareLinks).set(set).where(eq(shareLinks.id, link.id)).returning();
  return row!;
}

// ── tokens and URLs ─────────────────────────────────────────────────────────────────────────

export type Subject = { user: string } | { link: { id: string; passwordHash: string | null } };

type Versioned = { id: string; versionId: string | null };

/** The path of a files-host URL for `node`, with a token minted the way the API will mint it. */
export async function urlFor(
  kind: TokenKind,
  node: Versioned,
  subject: Subject,
  options: { size?: ThumbSize; pwv?: string; ver?: string } = {},
): Promise<string> {
  const claims: Omit<DownloadClaims, "v" | "exp"> = {
    k: kind,
    n: node.id,
    ver: options.ver ?? node.versionId!,
    ...("user" in subject
      ? { st: "u" as const, sub: subject.user }
      : {
          st: "l" as const,
          sub: subject.link.id,
          pwv: options.pwv ?? (await linkPwv(subject.link.passwordHash)),
        }),
  };
  if (kind === "thumb") claims.sz = options.size ?? 320;
  const { token } = await mintDownloadToken(keys, claims);
  return pathOf(kind, node.id, token, claims.sz);
}

export function pathOf(kind: TokenKind, nodeId: string, token: string, size?: number): string {
  const prefix = { download: "d", inline: "i", thumb: "t" }[kind];
  return kind === "thumb" ? `/${prefix}/${nodeId}/${size ?? 320}/${token}` : `/${prefix}/${nodeId}/${token}`;
}

const b64url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * A token over ANY payload, signed with the real key — for the claims the mint refuses to make
 * (an expired one, one without a subject, a kind that does not exist).
 */
export async function signRaw(payload: Record<string, unknown>): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign(
    "HMAC",
    await keys.get("download-token"),
    new TextEncoder().encode(`${body}.`),
  );
  return `${body}.${b64url(new Uint8Array(mac))}`;
}

export const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

// ── what a request left behind ──────────────────────────────────────────────────────────────

/** The ledger row of a subject for a day, or null when there is none. */
export async function ledgerRow(subjectType: LedgerSubject, subjectId: string, day = dayUTC(new Date())) {
  const [row] = await testDb()
    .select({ bytes: downloadLedger.bytes, count: downloadLedger.count })
    .from(downloadLedger)
    .where(
      and(
        eq(downloadLedger.day, day),
        eq(downloadLedger.subjectType, subjectType),
        eq(downloadLedger.subjectId, subjectId),
      ),
    );
  return row ?? null;
}

export const ledgerBytes = async (subjectType: LedgerSubject, subjectId: string, day?: string) =>
  (await ledgerRow(subjectType, subjectId, day))?.bytes ?? 0;

/** The `download_ip` subject of a client address on a day. */
export const ipSubject = (ip: string, at = new Date()) => ipHashDaily(keys, ip, dayUTC(at));

export async function accessLog(linkId: string) {
  return testDb().select().from(linkAccessLog).where(eq(linkAccessLog.linkId, linkId));
}

/** The body every 404 of a content route carries — a missing file's, byte for byte. */
export const NOT_FOUND = "Not found.\n";
export const MESSAGES = {
  invalid_token: "The link is not valid.\n",
  not_found: NOT_FOUND,
  scan_pending: "This file is still being scanned.\n",
  scan_blocked: "This file is blocked.\n",
  forbidden: "You do not have access to this.\n",
  link_paused: "This link is not available right now.\n",
  link_expired: "This link has expired.\n",
  ceiling_exceeded: "Daily limit reached.\n",
} as const;

export { TEST_APP_ORIGIN };

// ── bindings a test watches or replaces ─────────────────────────────────────────────────────

export type BucketSpy = {
  bucket: R2Bucket;
  gets: Array<{ key: string; options: R2GetOptions | undefined }>;
  heads: string[];
  puts: string[];
  /** How many bodies handed out by `get` were cancelled before their end. */
  cancelled: number;
};

/**
 * The real bucket, with every read recorded and every body watched for a cancel.
 * `splitAt: n` — a body arrives as two chunks, its first `n` bytes and the rest: a reader that
 * takes the first chunk and goes away has received exactly `n` bytes, whatever sizes the store
 * would have chosen and without a sleep.
 */
export function spyBucket(
  overrides: Partial<R2Bucket> = {},
  behaviour: { splitAt?: number } = {},
): BucketSpy {
  const real = env.FILES;
  const spy: BucketSpy = { bucket: null as unknown as R2Bucket, gets: [], heads: [], puts: [], cancelled: 0 };
  spy.bucket = {
    head: (key: string) => {
      spy.heads.push(key);
      return real.head(key);
    },
    get: async (key: string, options?: R2GetOptions) => {
      spy.gets.push({ key, options });
      const found = await real.get(key, options);
      if (!found || !("body" in found)) return found;
      let watched: ReadableStream<Uint8Array>;
      if (behaviour.splitAt !== undefined) {
        const whole = new Uint8Array(await new Response(found.body).arrayBuffer());
        const chunks = [whole.subarray(0, behaviour.splitAt), whole.subarray(behaviour.splitAt)].filter(
          (chunk) => chunk.byteLength > 0,
        );
        watched = new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = chunks.shift();
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          },
          cancel() {
            spy.cancelled += 1;
          },
        });
      } else {
        const source = found.body.getReader();
        watched = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await source.read();
            if (done) controller.close();
            else controller.enqueue(value);
          },
          async cancel(reason) {
            spy.cancelled += 1;
            await source.cancel(reason);
          },
        });
      }
      return new Proxy(found, {
        get: (target, name) => (name === "body" ? watched : Reflect.get(target, name, target)),
      });
    },
    put: (key: string, ...rest: unknown[]) => {
      spy.puts.push(key);
      return (real.put as (...args: unknown[]) => unknown)(key, ...rest);
    },
    ...overrides,
  } as unknown as R2Bucket;
  return spy;
}

export type ImagesMock = {
  binding: unknown;
  /** One entry per call of `input()`, with what `transform()` and `output()` were given. */
  calls: Array<{ transform?: unknown; output?: unknown }>;
};

/**
 * An IMAGES binding that records its calls and answers with `result()` — a made-up WebP unless
 * told otherwise. The input stream is read to its end, as the real service does.
 */
export function imagesMock(result: () => Promise<Uint8Array> | Uint8Array = () => FAKE_WEBP): ImagesMock {
  const mock: ImagesMock = { binding: null, calls: [] };
  mock.binding = {
    input(stream: ReadableStream<Uint8Array>) {
      const call: ImagesMock["calls"][number] = {};
      mock.calls.push(call);
      const chain = {
        transform(options: unknown) {
          call.transform = options;
          return chain;
        },
        async output(options: unknown) {
          call.output = options;
          await new Response(stream).arrayBuffer();
          const bytes = await result();
          return {
            response: () => new Response(bytes, { headers: { "content-type": "image/webp" } }),
            contentType: () => "image/webp",
            image: () => new Response(bytes).body!,
          };
        },
      };
      return chain;
    },
  };
  return mock;
}

/** Not a real picture: twelve bytes with a WebP container's first and third words. */
export const FAKE_WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

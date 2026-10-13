// The object store: a typed wrapper over the R2 binding (`env.FILES`) and the only place object
// keys are built.
//
// KEYS ARE IMMUTABLE. A new version of a file is a new `versionId` and therefore a new key; an old
// key is never written again, only deleted by purge. Trash is a database state.
//
//   u/<ownerId>/<nodeId>/<versionId>          an uploaded file version       keyFor
//   t/<nodeId>/<versionId>/<size>.webp        a cached thumbnail             thumbKey
//   a/<userId>/<uuid>                         an avatar                      avatarKey
//   b/…                                       backups and operational data   (their own task)
//
// `u/` HOLDS UPLOAD OBJECTS AND NOTHING ELSE. The bucket's one notification rule fires for every
// `put` and every multipart `complete` under that prefix — writes through this binding included —
// and each one becomes a scan message. A thumbnail, an avatar or a backup written under `u/`
// would be queued for scanning as if it were an upload. `keyFor` is the only helper that returns
// a `u/` key, and every helper validates its segments so that no id can smuggle a prefix in.
//
// What the store keeps beside the bytes says nothing about them: under `u/` the stored content
// type is always `application/octet-stream` (the served type comes from the database at serve
// time), and the custom metadata is `{ nodeId, ownerId }` only.
//
// There is no `listParts` on the binding: the parts of an open multipart upload are the rows of
// the `upload_parts` table, kept by the upload routes.

import { THUMB_SIZES, type ThumbSize } from "../../shared/constants";
import { BA_ID, UUID } from "../../shared/ids";

export const UPLOAD_PREFIX = "u/";
export const THUMB_PREFIX = "t/";
export const AVATAR_PREFIX = "a/";

const OCTET_STREAM = "application/octet-stream";
/** The most keys one delete call takes. */
export const DELETE_BATCH = 1_000;

// A version id, or any other single key segment: no slash, no dot-only names, nothing odd.
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
// A prefix that may be deleted or listed wholesale: a known area and at least one id below it.
const SCOPED_PREFIX = /^[utab]\/[A-Za-z0-9_-]{1,64}\/([A-Za-z0-9_.-]{1,64}\/)*$/;

function segment(value: string, pattern: RegExp, what: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`storage key: invalid ${what}`);
  return value;
}

/** The key of one version of an uploaded file. The ONLY helper that returns a `u/` key. */
export function keyFor(ownerId: string, nodeId: string, versionId: string): string {
  return `${UPLOAD_PREFIX}${segment(ownerId, BA_ID, "owner id")}/${segment(nodeId, UUID, "node id")}/${segment(versionId, SEGMENT, "version id")}`;
}

/** Versioned, so a replaced file can never be shown with the old version's thumbnail. */
export function thumbKey(nodeId: string, versionId: string, size: ThumbSize): string {
  if (!(THUMB_SIZES as readonly number[]).includes(size)) throw new Error("storage key: invalid thumb size");
  return `${thumbPrefix(nodeId, versionId)}${size}.webp`;
}

/** Every thumbnail of a node (`t/<nodeId>/`) or of one of its versions (`t/<nodeId>/<versionId>/`). */
export function thumbPrefix(nodeId: string, versionId?: string): string {
  const base = `${THUMB_PREFIX}${segment(nodeId, UUID, "node id")}/`;
  return versionId === undefined ? base : `${base}${segment(versionId, SEGMENT, "version id")}/`;
}

export function avatarKey(userId: string, uuid: string): string {
  return `${AVATAR_PREFIX}${segment(userId, BA_ID, "user id")}/${segment(uuid, UUID, "avatar id")}`;
}

/** The ids in a `u/` key; null for any other key. */
export function parseUploadKey(key: string): { ownerId: string; nodeId: string; versionId: string } | null {
  if (typeof key !== "string" || !key.startsWith(UPLOAD_PREFIX)) return null;
  const parts = key.slice(UPLOAD_PREFIX.length).split("/");
  if (parts.length !== 3) return null;
  const [ownerId, nodeId, versionId] = parts as [string, string, string];
  if (!BA_ID.test(ownerId) || !UUID.test(nodeId) || !SEGMENT.test(versionId)) return null;
  return { ownerId, nodeId, versionId };
}

export type PutBody = ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView;
export type PutOptions = {
  /** Used outside `u/` only (a thumbnail is `image/webp`). Under `u/` it is ignored. */
  contentType?: string;
  /** The exact length in bytes. A body of any other length fails and stores nothing. */
  size: number;
};
export type GetOptions = { range?: R2Range | Headers; onlyIf?: R2Conditional | Headers };
export type UploadedPart = { n: number; etag: string };
export type ListedObject = { key: string; size: number; etag: string; uploaded: Date };

export type Storage = {
  /**
   * One PUT. The store rejects a stream of unknown length, so a stream is always passed through
   * a fixed-length stream of `size` bytes; a buffer must be exactly `size` bytes long.
   */
  put(key: string, body: PutBody, options: PutOptions): Promise<R2Object>;
  head(key: string): Promise<R2Object | null>;
  /** With `onlyIf`, an object whose condition failed comes back without a body. */
  get(key: string, options?: GetOptions): Promise<R2ObjectBody | R2Object | null>;
  /** Deletes in batches of 1,000. Missing keys are not an error. */
  delete(keys: string[]): Promise<void>;
  /** Deletes everything under a SCOPED prefix (an area and at least one id). Returns the count. */
  deletePrefix(prefix: string): Promise<number>;
  list(prefix: string, cursor?: string): Promise<{ objects: ListedObject[]; cursor: string | null }>;
  createMultipart(key: string): Promise<R2MultipartUpload>;
  /** No request is made: an unknown upload id fails at the first call on the handle. */
  resumeMultipart(key: string, uploadId: string): R2MultipartUpload;
  /** `size` is needed for a stream that does not already carry its length (a request body does). */
  uploadPart(mpu: R2MultipartUpload, n: number, body: PutBody, size?: number): Promise<UploadedPart>;
  /**
   * The part rules are enforced HERE and only here — every `uploadPart` succeeds first: all parts
   * but the last must have the same size (error 10048) and be at least 5 MiB (error 10011). Both
   * errors are passed on as they are.
   */
  complete(mpu: R2MultipartUpload, parts: UploadedPart[]): Promise<R2Object>;
  /** Idempotent: aborting an upload that is already gone is not an error. */
  abort(mpu: R2MultipartUpload): Promise<void>;
};

function metadataFor(key: string, contentType: string | undefined) {
  const upload = parseUploadKey(key);
  if (key.startsWith(UPLOAD_PREFIX)) {
    if (!upload) throw new Error("storage key: not a valid upload key");
    return {
      httpMetadata: { contentType: OCTET_STREAM },
      customMetadata: { nodeId: upload.nodeId, ownerId: upload.ownerId },
    };
  }
  return { httpMetadata: { contentType: contentType ?? OCTET_STREAM } };
}

function sized(body: PutBody, size: number | undefined): PutBody {
  if (body instanceof ReadableStream) {
    if (size === undefined) return body;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("storage: invalid size");
    return body.pipeThrough(new FixedLengthStream(size));
  }
  if (size !== undefined && body.byteLength !== size)
    throw new Error("storage: the body is not the declared size");
  return body;
}

function scoped(prefix: string): string {
  if (typeof prefix !== "string" || !SCOPED_PREFIX.test(prefix))
    throw new Error("storage: prefix is not scoped");
  return prefix;
}

/** The storage service over this environment's bucket. Cheap: build it where it is used. */
export function storage(env: Pick<Env, "FILES">): Storage {
  const bucket = env.FILES;

  async function list(prefix: string, cursor?: string) {
    const page = await bucket.list({ prefix: scoped(prefix), cursor, limit: DELETE_BATCH });
    return {
      objects: page.objects.map((o) => ({ key: o.key, size: o.size, etag: o.etag, uploaded: o.uploaded })),
      cursor: page.truncated ? page.cursor : null,
    };
  }

  async function remove(keys: string[]): Promise<void> {
    for (let at = 0; at < keys.length; at += DELETE_BATCH) {
      await bucket.delete(keys.slice(at, at + DELETE_BATCH));
    }
  }

  return {
    async put(key, body, options) {
      if (!Number.isSafeInteger(options.size) || options.size < 0) throw new Error("storage: invalid size");
      const stored = await bucket.put(key, sized(body, options.size), metadataFor(key, options.contentType));
      return stored;
    },
    head: (key) => bucket.head(key),
    get: (key, options = {}) => bucket.get(key, options),
    delete: remove,
    async deletePrefix(prefix) {
      let deleted = 0;
      // Always from the start: what was listed is gone by the next pass.
      for (;;) {
        const page = await list(prefix);
        if (page.objects.length === 0) return deleted;
        await remove(page.objects.map((object) => object.key));
        deleted += page.objects.length;
        if (page.cursor === null) return deleted;
      }
    },
    list,
    createMultipart: (key) => bucket.createMultipartUpload(key, metadataFor(key, undefined)),
    resumeMultipart: (key, uploadId) => bucket.resumeMultipartUpload(key, uploadId),
    async uploadPart(mpu, n, body, size) {
      const part = await mpu.uploadPart(n, sized(body, size));
      return { n: part.partNumber, etag: part.etag };
    },
    complete(mpu, parts) {
      const ordered = [...parts].sort((a, b) => a.n - b.n);
      return mpu.complete(ordered.map((part) => ({ partNumber: part.n, etag: part.etag })));
    },
    async abort(mpu) {
      try {
        await mpu.abort();
      } catch (error) {
        // 10024: the upload does not exist — already aborted, completed or expired.
        if (!/10024|does not exist|NoSuchUpload/i.test(error instanceof Error ? error.message : ""))
          throw error;
      }
    },
  };
}

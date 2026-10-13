// Shapes every other contract builds on. Ids are strings, timestamps ISO-8601 strings, byte
// counts numbers.

import { z } from "zod";
import { MIME_CATEGORY_NAMES } from "../constants";
import { ERROR_STATUS, type ErrorCode as ErrorCodeName } from "../errors";
import { BA_ID, TOKEN, UUID } from "../ids";

/**
 * A user id: the auth library's 32 alphanumeric characters. Never a UUID — the two id families
 * are not interchangeable, and a schema that takes a user id uses this, not `NodeId`.
 */
export const UserId = z.string().regex(BA_ID);
export type UserId = z.infer<typeof UserId>;

/** A session id has the same shape as a user id. */
export const SessionId = z.string().regex(BA_ID);
export type SessionId = z.infer<typeof SessionId>;

/** The id of one of our own rows: a node, an upload, a share, a link, a report (UUID v7). */
export const NodeId = z.uuid();
export type NodeId = z.infer<typeof NodeId>;

/** Any of our own row ids. Same shape as `NodeId`; the name says what the field holds. */
export const RowId = z.string().regex(UUID);
export type RowId = z.infer<typeof RowId>;

/** A bearer token carried in a path or a body (a public link token). */
export const PathToken = z.string().regex(TOKEN).max(128);
export type PathToken = z.infer<typeof PathToken>;

/** An instant, as `Date.prototype.toISOString()` writes it. */
export const Timestamp = z.iso.datetime();
export type Timestamp = z.infer<typeof Timestamp>;

/** A whole number of bytes. */
export const Bytes = z.number().int().nonnegative();

/** A SHA-256 digest: 64 lower-case hex characters. */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Never carries an email address. */
export const UserRef = z.object({ id: UserId, displayName: z.string() });
export type UserRef = z.infer<typeof UserRef>;

/** One page of a cursor-paged list. `nextCursor` is opaque; null on the last page. */
export const Page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export type Page<T> = { items: T[]; nextCursor: string | null };

export const Role = z.enum(["viewer", "editor", "owner"]);
export type Role = z.infer<typeof Role>;

/**
 * What a non-admin can ever see. The database has a seventh status, `suspected_csam`, which never
 * reaches one of these contracts (the admin contracts have their own type).
 */
export const ScanStatus = z.enum(["pending", "clean", "infected", "under_review", "skipped", "error"]);
export type ScanStatus = z.infer<typeof ScanStatus>;

/** Why a scan ended `skipped` or `error`. */
export const ScanReason = z.enum(["size", "encrypted", "limits", "timeout", "engine", "hash_mismatch"]);
export type ScanReason = z.infer<typeof ScanReason>;

export const MimeCategory = z.enum(MIME_CATEGORY_NAMES);
export type MimeCategory = z.infer<typeof MimeCategory>;

const ERROR_CODES = Object.keys(ERROR_STATUS) as [ErrorCodeName, ...ErrorCodeName[]];
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** The body of every error answer of the app host. */
export const ErrorBody = z.object({
  error: ErrorCode,
  message: z.string(),
  requestId: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** A file or folder name as the client sends it. The server normalises and validates it further. */
export const NodeName = z.string().min(1).max(255);

/** An email address as typed, at most the 254 characters a mailbox can have. */
export const Email = z.email().max(254);

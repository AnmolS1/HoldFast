// Permanent deletion. `purgeRoot` is the ONLY code that deletes node rows or their objects, and
// `purgeVersions` the only code that deletes kept old versions; both go through the gate in
// queries/trash.ts, which takes the owner's tree lock itself — so the gate's call is the first
// statement of the transaction here, and nothing is locked before it.
//
//   purgeRoot(c, id, "user")        DELETE /nodes/:id, DELETE /trash     audit `node.purge_requested`
//                                                                        and `node.purge`
//   purgeRoot(bg, id, "cron")       the purge job                        audit `system.purge`
//   purgeRoot(bg, id, "account")    the account purge's roots            audit `system.purge`
//
// One transaction: the owner's tree lock, the root re-read under it (still trashed? still due? —
// its owner may have restored it since the caller looked), the rows, the bytes given back and
// the audit row — all or none (no purge without its record). The objects go AFTER the commit: a crash in between
// leaves objects nothing references, which the reconcile job's orphan sweep removes; no row ever
// points at a missing object.
//
// A HELD root is never deleted, by any caller, and never in part: the answer is `held` and
// nothing has changed. What the caller then does differs (the job stamps the attempt, a route
// records the request and answers as if the purge had happened).

import type { Context } from "hono";
import type { Db, Tx } from "../db/client";
import { LegalHoldError, pgError } from "../db/errors";
import { release } from "../db/queries/quota";
import { lockTreeForPurge, type PurgeRule } from "../db/queries/trash-jobs";
import {
  type DeletedRows,
  deleteSubtreeRows,
  deleteVersionRows,
  markPurgeAttempted,
  purgeDue,
  versionsDue,
} from "../db/queries/trash";
import { retryOnDeadlock } from "../db/retry";
import { captureError } from "../sentry";
import { auditInTx } from "../services/audit";
import { deps, type AppEnv, type BackgroundContext } from "../services/request-context";
import { storage } from "../services/storage";
import type { Job } from "./index";

export type PurgeSource = Context<AppEnv> | BackgroundContext;
export type PurgeReason = "user" | "cron" | "account";

/**
 * `purged`: rows and record committed (`cleaned: false` when an object could not be removed —
 * the orphan sweep will); `held`: refused by the gate, nothing changed; `skipped`: the root is no
 * longer what this caller may purge (it was restored meanwhile), nothing changed; `missing`: no
 * such root; `retry`: a job's transaction was ended by Postgres (deadlock, serialization) — next
 * tick.
 */
export type PurgeResult =
  | { outcome: "purged"; freedBytes: number; objects: number; cleaned: boolean }
  | { outcome: "held" }
  | { outcome: "skipped" }
  | { outcome: "missing" }
  | { outcome: "retry" };

/** What each caller may purge. The list or the read it acted on is advice; this is re-asked under the lock. */
const RULES: Record<PurgeReason, PurgeRule> = { cron: "due", user: "trashed", account: "any" };

/** Roots and versions taken from the queue at once. */
export const PURGE_BATCH = 200;
const DEFAULT_SOFT_DEADLINE_MS = 60_000;

const RETRYABLE = new Set(["40P01", "40001"]);

function isContext(source: PurgeSource): source is Context<AppEnv> {
  return "req" in source && "executionCtx" in source;
}

/**
 * A request retries a deadlock in place (the shared helper's default); a job does not — the
 * root is skipped and taken again on the next tick.
 */
async function inTransaction<T>(source: PurgeSource, run: (tx: Tx) => Promise<T>): Promise<T> {
  if (isContext(source)) return retryOnDeadlock(deps(source).db, run);
  const db: Db = source.db;
  return retryOnDeadlock(db, run, { attempts: 1 });
}

/** What the committed rows leave in the store. Never throws: the rows are already gone. */
async function removeObjects(env: Env, deleted: DeletedRows): Promise<boolean> {
  const store = storage(env);
  let cleaned = true;
  const attempt = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      cleaned = false;
      captureError(error, { kind: "purge_objects" });
    }
  };
  await attempt(() => store.delete(deleted.r2Keys));
  for (const prefix of deleted.thumbPrefixes) await attempt(() => store.deletePrefix(prefix));
  for (const upload of deleted.uploadsToAbort) {
    // A single-PUT session has no multipart upload. An object its PUT left at the key is
    // referenced by nothing now: the orphan sweep takes it, under its own guards.
    const uploadId = upload.r2UploadId;
    if (uploadId === null) continue;
    await attempt(() => store.abort(store.resumeMultipart(upload.r2Key, uploadId)));
  }
  return cleaned;
}

async function purge(
  source: PurgeSource,
  rows: (tx: Tx) => Promise<DeletedRows | null>,
  record: (tx: Tx, deleted: DeletedRows) => Promise<void>,
): Promise<PurgeResult> {
  let deleted: DeletedRows | null;
  try {
    deleted = await inTransaction(source, async (tx) => {
      const gone = await rows(tx);
      if (gone === null || gone.ownerId === null) return gone;
      await release(tx, gone.ownerId, gone.freedBytes);
      await record(tx, gone);
      return gone;
    });
  } catch (error) {
    if (error instanceof LegalHoldError) return { outcome: "held" };
    if (!isContext(source) && RETRYABLE.has(pgError(error)?.code ?? "")) return { outcome: "retry" };
    throw error;
  }
  if (deleted === null) return { outcome: "skipped" };
  if (deleted.ownerId === null) return { outcome: "missing" };
  // Only now, and only what the committed transaction returned.
  const cleaned = await removeObjects(source.env, deleted);
  return { outcome: "purged", freedBytes: deleted.freedBytes, objects: deleted.r2Keys.length, cleaned };
}

/**
 * Deletes the root and everything under it. Whether it may go is decided HERE, inside the
 * transaction and under the owner's tree lock, from the root as it is then — not from the list
 * or the read the caller acted on: a root that was restored in between is `skipped`.
 * See the header for what one call does.
 */
export async function purgeRoot(
  source: PurgeSource,
  rootId: string,
  reason: PurgeReason,
): Promise<PurgeResult> {
  const action = reason === "user" ? "node.purge" : "system.purge";
  return purge(
    source,
    async (tx) =>
      (await lockTreeForPurge(tx, rootId, RULES[reason])) ? deleteSubtreeRows(tx, rootId) : null,
    async (tx, gone) => {
      // A user's delete is two facts: they asked, and it happened. Both rows, with the deletes.
      if (reason === "user") await recordPurgeRequest(tx, source, rootId);
      // Short facts only: how much went. No name, no key.
      await auditInTx(
        tx,
        source,
        action,
        { type: "node", id: rootId },
        {
          reason,
          objects: gone.r2Keys.length,
          bytes: gone.freedBytes,
        },
      );
    },
  );
}

/**
 * The record that an account holder asked for a root to be deleted for good: `node.purge_requested`,
 * written on the transaction that acts on the request — the deletes, or, for a root the gate
 * refused, the purge-request marker — so that the request and its record commit or fail together.
 * THE SAME ROW EITHER WAY: the node, who asked, and nothing that says whether it was held. For a
 * held root it is the only trace that its owner tried to destroy it.
 */
export async function recordPurgeRequest(tx: Tx, source: PurgeSource, rootId: string): Promise<void> {
  await auditInTx(tx, source, "node.purge_requested", { type: "node", id: rootId });
}

/** Deletes kept old versions of one file, behind the same gate: a held file keeps its history. */
export async function purgeVersions(
  bg: BackgroundContext,
  nodeId: string,
  versionIds: readonly string[],
): Promise<PurgeResult> {
  return purge(
    bg,
    (tx) => deleteVersionRows(tx, nodeId, versionIds),
    (tx, gone) =>
      auditInTx(
        tx,
        bg,
        "system.purge",
        { type: "node", id: nodeId },
        {
          reason: "version",
          objects: gone.r2Keys.length,
          bytes: gone.freedBytes,
        },
      ),
  );
}

// ── the job ─────────────────────────────────────────────────────────────────────────────────

/**
 * Trashed roots past their date and roots whose purge was requested, then old versions past
 * theirs. Idempotent and resumable: what a tick does not reach is still due on the next.
 */
export const job: Job = {
  name: "purge",
  cron: "17 */6 * * *",
  async run(bg, _env, _event, opts) {
    const stopAt = Date.now() + (opts?.softDeadlineMs ?? DEFAULT_SOFT_DEADLINE_MS);
    const over = () => Date.now() >= stopAt;
    const count = (outcome: string) => bg.metric("job", { kind: "purge", outcome });
    // What this run has already tried. A root the gate refused is stamped and goes to the back
    // of the queue; one that failed otherwise comes back first — it is not tried twice in a run.
    const seen = new Set<string>();

    for (;;) {
      const due = (await purgeDue(bg.db, PURGE_BATCH)).filter((root) => !seen.has(root.id));
      if (due.length === 0) break;
      const refused: string[] = [];
      for (const root of due) {
        seen.add(root.id);
        try {
          const result = await purgeRoot(bg, root.id, "cron");
          if (result.outcome === "held") refused.push(root.id);
          if (result.outcome !== "missing") count(result.outcome);
        } catch (error) {
          // One root that cannot be purged must not stop the roots behind it.
          captureError(error, { kind: "job", job: "purge" });
          count("error");
          refused.push(root.id);
        }
        if (over()) break;
      }
      await markPurgeAttempted(bg.db, refused);
      if (over()) return { done: false };
    }

    for (;;) {
      const versionKey = (v: { nodeId: string; versionId: string }) => `${v.nodeId}/${v.versionId}`;
      const due = (await versionsDue(bg.db, PURGE_BATCH)).filter((v) => !seen.has(versionKey(v)));
      if (due.length === 0) break;
      const byNode = new Map<string, string[]>();
      for (const version of due) {
        seen.add(versionKey(version));
        byNode.set(version.nodeId, [...(byNode.get(version.nodeId) ?? []), version.versionId]);
      }
      for (const [nodeId, versionIds] of byNode) {
        try {
          const result = await purgeVersions(bg, nodeId, versionIds);
          if (result.outcome !== "missing") count(result.outcome);
        } catch (error) {
          captureError(error, { kind: "job", job: "purge" });
          count("error");
        }
        if (over()) return { done: false };
      }
    }
    return { done: true };
  },
};

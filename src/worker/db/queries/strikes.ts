// Strikes: the three statements the strikes service needs. Nothing else reads or writes the table.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { strikes } from "../schema";

export type StrikeKind = (typeof strikes.kind.enumValues)[number];

export type StrikeInput = {
  /** The uploader. */
  userId: string;
  kind: StrikeKind;
  reportId?: string | null;
  nodeId?: string | null;
  note?: string | null;
  /** Null = the system. */
  issuedBy?: string | null;
};

/** Inserts one strike and returns its id. */
export async function insert(tx: Executor, strike: StrikeInput): Promise<string> {
  const [row] = await tx
    .insert(strikes)
    .values({
      userId: strike.userId,
      kind: strike.kind,
      reportId: strike.reportId ?? null,
      nodeId: strike.nodeId ?? null,
      note: strike.note ?? null,
      issuedBy: strike.issuedBy ?? null,
    })
    .returning({ id: strikes.id });
  return row!.id;
}

/** The user's strikes that are not lifted and were issued in the last `windowDays` days. */
export async function countActive(db: Executor, userId: string, windowDays: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(strikes)
    .where(
      and(
        eq(strikes.userId, userId),
        isNull(strikes.liftedAt),
        sql`${strikes.at} > now() - make_interval(days => ${windowDays})`,
      ),
    );
  return row?.n ?? 0;
}

/**
 * Lifts a strike. Returns whose it was, or null when there is no such strike or it is already
 * lifted (nothing is changed then).
 */
export async function lift(db: Executor, strikeId: string, by: string): Promise<{ userId: string } | null> {
  if (!isUuid(strikeId)) return null;
  const [row] = await db
    .update(strikes)
    .set({ liftedAt: sql`now()`, liftedBy: by })
    .where(and(eq(strikes.id, strikeId), isNull(strikes.liftedAt)))
    .returning({ userId: strikes.userId });
  return row ?? null;
}

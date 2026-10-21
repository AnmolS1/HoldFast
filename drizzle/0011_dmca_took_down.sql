ALTER TABLE "dmca_notice_nodes" ADD COLUMN "took_down" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill (expand-only): a notice that took a takedown (dmca_notices.takedown_at set) "took down"
-- each node it names whose takedown is a dmca one made by a person (nodes.takedown_reason = 'dmca'
-- AND nodes.takedown_by IS NOT NULL). The scanner's own dmca takedowns (takedown_by NULL) and
-- takedowns for another reason are not a notice's.
UPDATE "dmca_notice_nodes" AS dn SET "took_down" = true
FROM "dmca_notices" AS d, "nodes" AS n
WHERE d."id" = dn."notice_id" AND n."id" = dn."node_id"
  AND d."takedown_at" IS NOT NULL
  AND n."takedown_reason" = 'dmca' AND n."takedown_by" IS NOT NULL;

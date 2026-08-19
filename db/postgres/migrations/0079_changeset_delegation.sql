-- 0079: changeset approval delegation + supersession status (AQU-CMDREG P1).
--
-- Two additive changes to `changesets`:
--
-- 1. `assigned_to_user_id` — routing. Per the decision-channel doctrine
--    (docs/superpowers/specs/2026-08-15-agent-onboarding-seam-design.md §4.3),
--    an assignment names who is EXPECTED to act; it never resolves anything.
--    A changeset with an assignee is still `staged`. Nullable: absent means
--    "whoever holds the floor gets to it first".
--
-- 2. `superseded` status — a plan whose intended end-state already exists,
--    because a human (or another run) did the work by hand. It is distinct
--    from `stale` (preconditions drifted some OTHER way) and from `expired`
--    (nobody acted before the TTL). Merging superseded into either would let
--    the healthy case inflate a count that exists to warn about an unhealthy
--    one.
--
-- Additive only: no existing row is rewritten, no required column is added.
-- Old workers ignore the new column and never write the new status.
--
-- NOT applied automatically to live Neon branches. Apply by hand:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0079_changeset_delegation.sql

ALTER TABLE changesets
  ADD COLUMN IF NOT EXISTS assigned_to_user_id TEXT;

-- Widen the status CHECK to admit 'superseded'. The constraint is unnamed in
-- schema.sql, so find it by definition rather than by a guessed name.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'changesets'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%staged%committing%';

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE changesets DROP CONSTRAINT %I', con_name);
  END IF;

  ALTER TABLE changesets
    ADD CONSTRAINT changesets_status_check
    CHECK (status IN ('staged', 'committing', 'committed', 'discarded',
                      'stale', 'superseded', 'expired'));
END $$;

-- Surfacing the inbox reads staged rows for one project, newest first, and
-- ranks them; the existing (project_id, status) index already serves it.
-- Assignment lookups ("what is routed to me") need their own partial index.
CREATE INDEX IF NOT EXISTS idx_changesets_assignee
  ON changesets(assigned_to_user_id, status)
  WHERE assigned_to_user_id IS NOT NULL;

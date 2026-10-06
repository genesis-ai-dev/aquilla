-- Migration 0151: fact questions on contextual_decisions (AQU-1691).
--
-- A contextual decision used to end as steering text, `Decision: <reason> /
-- Human answer: <answer>`, which autopilot consumes after ONE wave. So an
-- answer never reached a later wave, another run, or another file. The
-- decision stays the ASKING channel; the answer is now stored as a durable
-- project fact (`projectFacts`, or the Language-profile slot its key names),
-- written in the same transaction that resolves the decision
-- (db/shared/contextual-decision-lifecycle.ts). A question that asks for a
-- fact needs four things this table could not hold:
--
--   readiness_item 'bible-fact'  the CHECK widens to allow it;
--   fact_key   TEXT              the key the answer is stored under, e.g.
--                                "kin.andrew-peter.relative-age" or "measures";
--   options    JSONB             one-click answers, [{ "value", "label"? }];
--   fact_scope JSONB             where the fact applies,
--                                { "book"?, "passage"?: { "from", "to" }, "entity"? };
--   file_id    nullable          most fact questions belong to the project,
--                                not to one file.
--
-- WHAT IT COSTS TO APPLY. The new columns have no default and allow NULL, and
-- DROP NOT NULL changes only the catalog, so none of them rewrites the table.
-- Re-adding the CHECK scans the existing rows to validate them, under the
-- ACCESS EXCLUSIVE lock. The table holds one row per question ever raised, so
-- the scan is short; NOT VALID + VALIDATE would gain nothing here, because
-- the ALTER in the same transaction holds the stronger lock to the end anyway.
--
-- DEPLOY ORDER. Apply this migration BEFORE deploying the auth-worker from
-- AQU-1691. That worker names fact_key, options and fact_scope in EVERY
-- decision read, including the trust gate in each autopilot wave, so on a
-- database without them every run would fail at its next wave. The reverse
-- order is safe: the current worker never reads the new columns, always sends
-- a file_id, and never raises a 'bible-fact' question.
--
-- Safe to re-run: IF NOT EXISTS on the columns, DROP CONSTRAINT IF EXISTS
-- before the new CHECK, and DROP NOT NULL is a no-op on a nullable column.

BEGIN;
-- Give up after 5s of WAITING for the lock (this does not limit how long the
-- ALTER then holds it), so it cannot queue every decision read behind one
-- long-running transaction. If this times out nothing has changed: run the
-- migration again.
SET LOCAL lock_timeout = '5s';

ALTER TABLE contextual_decisions
  ADD COLUMN IF NOT EXISTS fact_key TEXT,
  ADD COLUMN IF NOT EXISTS options JSONB,
  ADD COLUMN IF NOT EXISTS fact_scope JSONB,
  ALTER COLUMN file_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS contextual_decisions_readiness_item_check,
  ADD CONSTRAINT contextual_decisions_readiness_item_check
    CHECK (readiness_item IS NULL OR
           readiness_item IN ('terminology','brief','examples','rules','languages','bible-fact'));
COMMIT;

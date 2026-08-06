-- Persist the current untouched AI draft's provenance on the cells projection.
-- Translate-as-read uses this snapshot to prove that newly available validated
-- examples are materially better before it replaces any existing draft.

BEGIN;

ALTER TABLE cells ADD COLUMN IF NOT EXISTS ai_draft JSONB;

-- Older current heads may predate the projection marker while still carrying
-- the explicit ai_suggestion bit on their winning event. Restore ownership for
-- unvalidated heads only; validation remains an absolute human stop sign.
UPDATE cells AS c
SET ai_drafted = 1,
    ai_draft = e.payload::jsonb -> 'ai_draft'
FROM events AS e
WHERE c.side = 'target'
  AND c.validated = 0
  AND c.event_id = e.id
  AND e.payload::jsonb ->> 'ai_suggestion' = 'true'
  AND (c.ai_drafted = 0 OR c.ai_draft IS NULL);

COMMIT;

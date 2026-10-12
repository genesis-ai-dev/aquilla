-- Migration 0153: concepts.external_ids, a terminology concept's link to a
-- Bible entity (AQU-1693).
--
-- Voices and Who's Who name a participant with the project's own agreed
-- rendering ("Yesus"). Until now they found it by matching the entity's label
-- in the SOURCE language against concept headwords, which fails when the pack
-- has no label in that language (a Greek source) or the names differ. A concept
-- can now name its entity exactly: `{"acai": "person:Jesus.2"}`, the ACAI id
-- the Bible Knowledge Pack keys entities by.
--
-- Written by the term.create / term.update projection (event-projection.ts),
-- read by the concepts read route. NULL, and the `{}` an unlink writes, mean no
-- link. Nullable with no default, so adding it rewrites no rows and every
-- existing concept is simply unlinked.
--
-- Apply BEFORE deploying the sync-worker that writes it: the term.create
-- INSERT names this column.

ALTER TABLE concepts ADD COLUMN IF NOT EXISTS external_ids JSONB;

-- Migration 0207: who may edit source text (AQU-2647).
--
-- WHY. Editing source text, hiding a cell, and splitting a line at quotes
-- share one floor. It used to be hard-coded to Project Lead. The default is
-- now Maintainer. A project may set its own tier; otherwise it follows its
-- organization (db/shared/source-text-floor.ts). POST /events answers the
-- project's own value on source.cell.commit and source.cell.visibility.set,
-- so the key joins the write-path projection (0171) rather than reopening
-- the settings blob.
--
-- JSONB and not `->>` TEXT, for 0171's reason: the reader's guard is a
-- string compare, and `->` keeps the value's JSON type so an unrecognised
-- value stays unrecognised and reads as maintainer — never looser.
--
-- EXISTING ORGANIZATIONS. Every organization moves to Maintainer by leaving
-- the key absent. The organization named exactly 'Biblica ETT' keeps Project
-- Lead. That string is BIBLICA_ETT_ORG_NAME in db/shared/source-text-floor.ts,
-- the display name this repo already uses for that organization. The schema
-- does not constrain organizations.name to be unique, so this updates every
-- row with that exact name. It does not match a project id or a user id.
--
-- WHAT THE COLUMN COSTS TO APPLY. Adding a STORED generated column rewrites
-- project_settings under an ACCESS EXCLUSIVE lock. Apply it at a quiet time,
-- as with 0171 and 0205. The organization update is a separate transaction
-- and does not take that lock.
--
-- DEPLOY ORDER. Apply this before the sync-worker that SELECTs the column.
-- It is not a safety requirement: without the column the reader falls back
-- to the blob (request-cache.ts) and the authority answer is the same.

BEGIN;
-- Give up after 5s of WAITING for the lock (this does not limit how long the
-- rewrite then holds it). If this times out nothing in this transaction has
-- changed: run the migration again.
SET LOCAL lock_timeout = '5s';

ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS wp_source_text_floor JSONB
    GENERATED ALWAYS AS ((settings::jsonb) -> 'sourceTextFloor') STORED;
COMMIT;

BEGIN;
INSERT INTO org_settings (org_id, settings, version)
SELECT o.id, '{"sourceTextFloor":"project_lead"}', 0
  FROM organizations o
 WHERE o.name = 'Biblica ETT'
   AND NOT EXISTS (SELECT 1 FROM org_settings s WHERE s.org_id = o.id);

UPDATE org_settings AS s
   SET settings = ((s.settings::jsonb) || '{"sourceTextFloor":"project_lead"}'::jsonb)::text,
       version = s.version + 1
  FROM organizations AS o
 WHERE s.org_id = o.id
   AND o.name = 'Biblica ETT'
   AND COALESCE(s.settings::jsonb ->> 'sourceTextFloor', '') IS DISTINCT FROM 'project_lead';
COMMIT;

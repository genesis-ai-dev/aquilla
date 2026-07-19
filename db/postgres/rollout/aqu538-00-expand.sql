-- aqu538-00-expand.sql — PHASE 0 (expand): backward-compatible column adds.
--
-- Zero-downtime rollout of AQU-538 target-language lanes to an EXISTING,
-- populated Neon branch (e.g. main/production). This file replaces the
-- column-add portions of migrations 0057/0058/0060 and the new table from
-- 0059. It is SAFE to run while the OLD (pre-lane) workers are still serving:
--   * Every ADD COLUMN uses a constant DEFAULT '' → Postgres 11+ records it as
--     catalog metadata only (no table rewrite, no long lock), instant even on a
--     multi-million-row `cells`.
--   * No primary key is touched here. The old 4-column PKs stay in force, so the
--     currently-deployed code's `ON CONFLICT(project_id,file_id,cell_id,side)`
--     upserts keep working unchanged.
--
-- Apply:  set -a; . ./.env; set +a
--         npx tsx scripts/pg.ts db/postgres/rollout/aqu538-00-expand.sql
--
-- Idempotent (IF NOT EXISTS throughout). Runs as a single implicit transaction.

-- Lane dimension on the three per-lane tables (default lane = literal '').
ALTER TABLE cells                 ADD COLUMN IF NOT EXISTS target_lang TEXT NOT NULL DEFAULT '';
ALTER TABLE cell_validators       ADD COLUMN IF NOT EXISTS target_lang TEXT NOT NULL DEFAULT '';
ALTER TABLE file_section_progress ADD COLUMN IF NOT EXISTS target_lang TEXT NOT NULL DEFAULT '';

-- Assignments carry a lane pin but keep assignment_id as the sole PK (0060) —
-- no PK change, so this column is fully backward-compatible on its own.
ALTER TABLE assignments           ADD COLUMN IF NOT EXISTS target_lang TEXT NOT NULL DEFAULT '';

-- Lane-scoped reviewer permissions (0059, AQU-553). New table — old code never
-- reads it, so it is inert until the new sync-worker enforces it.
CREATE TABLE IF NOT EXISTS project_member_scopes (
    project_id TEXT NOT NULL,
    user_id    BIGINT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('lane','file')),
    value      TEXT NOT NULL,
    created_by TEXT,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (project_id, user_id, kind, value)
);

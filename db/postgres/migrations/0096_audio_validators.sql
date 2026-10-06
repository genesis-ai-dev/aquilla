-- AQU-490: audio validation becomes a vote per person per take, counted
-- against a threshold at READ time — the same shape text validation has had
-- since FRO-279, for the same reason.
--
-- What was here before (0052, "unblocking AQU-490") was a single boolean per
-- take: cell_audio.approved, plus who and when. No client ever wrote it, so
-- every audio-validated number in the product is zero. Rather than wire a
-- client to a model that cannot express "two reviewers required", this moves
-- audio onto the text model: rows in a validators table, a denormalized count
-- beside the take, and a histogram on the progress row so a project can change
-- its required count without reprojecting anything.
--
-- WHY A `role` COLUMN. `selected = 1` does not mean "somebody recorded a dub
-- here". On an imported media file the shared programme audio sits in the
-- `recording` slot, selected, one row per cell, and the generated-voice path
-- deliberately re-selects it so a TTS take can be heard over it. Measured on a
-- dev database: of 127 selected live rows in one file's recording slot, 124
-- were that source clip. The rule "every selected take must be validated"
-- would therefore have held almost every media cell hostage to somebody
-- validating untranslated source audio. `role` makes the distinction a fact
-- about the row, written once at attach, instead of a string-prefix heuristic
-- re-evaluated inside the hottest projection in the codebase.
--
-- `approved`/`approved_by`/`approved_ts` are deliberately LEFT IN PLACE and
-- simply stop being read. Nothing writes them today, so there is nothing to
-- migrate; a contract migration can drop them once no deployed worker refers
-- to them.
--
-- NO BACKFILL HERE, deliberately, following 0094: the histogram is an
-- aggregate the projection already knows how to compute, and a second
-- hand-written copy of that arithmetic in SQL is how the two drift. The
-- projection is the backfill. Until it runs every row reads '{}' and every
-- threshold sums to zero, which is exactly today's behaviour.
--
-- The `role` and `created_by` backfills are a different matter — they recover
-- facts from the event log, not an aggregate — and they are NOT here either.
-- `events` has no index on `kind` and its payload is TEXT, so recovering the
-- earliest attach per take is a per-project scan. It lives in
-- db/postgres/rollout/aqu490-audio-validators.sql, to be run project by
-- project with the numbers measured first.
--
-- NOT applied automatically to live Neon branches (neon:status is a deploy
-- precondition and will fail until this has run). Apply through the migration
-- runner — a by-hand `scripts/pg.ts` apply leaves the deploy gate red:
--   pnpm neon:apply:prod
--   pnpm neon:backfill:progress:prod --missing-books

BEGIN;

-- One row per (take, person). Presence IS the vote; unvalidating DELETEs,
-- exactly as cell_validators does — see its note in schema.sql. No target_lang:
-- unlike text, a recording is shared by every target language of the project,
-- so a vote on it is not per-lane.
CREATE TABLE IF NOT EXISTS cell_audio_validators (
    project_id TEXT   NOT NULL,
    file_id    TEXT   NOT NULL,
    cell_id    TEXT   NOT NULL,
    audio_id   TEXT   NOT NULL,
    username   TEXT   NOT NULL,
    decided_ts BIGINT NOT NULL,
    PRIMARY KEY (project_id, file_id, cell_id, audio_id, username)
);

-- "Which takes have I validated?" is a per-viewer question the editor asks for
-- a whole file at once; the primary key's leading columns cannot serve it.
CREATE INDEX IF NOT EXISTS idx_cell_audio_validators_user
    ON cell_audio_validators(project_id, username);

-- THE GRANT COMES FIRST, and a policy is not a substitute for it. 0034 says so
-- outright — tables are enumerated explicitly "so future migrations opt in
-- deliberately" — and every table-creating migration since has carried this
-- line. Without it, FORCE ROW LEVEL SECURITY on a table app_runtime has no
-- privileges over means "permission denied for table cell_audio_validators"
-- on every statement that touches it. That is not limited to casting a vote:
-- the per-file audio read joins this table laterally, so opening ANY file's
-- audio would 500. Local dev hides it completely — schema.sql carries no RLS
-- at all — so this would have passed every check here and failed on first
-- contact with a database that has the 0034 chain applied.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cell_audio_validators TO app_runtime;

-- Every sibling projection table carries a policy (0034). A new one without
-- would be readable for every project by app_runtime.
ALTER TABLE cell_audio_validators ENABLE ROW LEVEL SECURITY;
ALTER TABLE cell_audio_validators FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_cell_audio_validators_project_access ON cell_audio_validators;
CREATE POLICY rls_cell_audio_validators_project_access ON cell_audio_validators
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id));

ALTER TABLE cell_audio
  -- Votes on this take. The audio twin of cells.endorsement_count: a COUNT,
  -- never a stamp, so a projection rebuild cannot leave it saying the wrong
  -- thing at the wrong threshold.
  ADD COLUMN IF NOT EXISTS validator_count INTEGER NOT NULL DEFAULT 0
    CHECK (validator_count >= 0),
  -- Who recorded it. The self-validation rule needs an author and the row has
  -- never had one; event_id cannot stand in for it, because a partial
  -- re-attach (the transcription that lands ~800ms after every recording)
  -- overwrites event_id with a later author's event.
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  -- 'dub' = somebody's translation of this line. 'source' = the shared
  -- programme audio an import attached. Only dubs are validated, counted, or
  -- auto-validated. See the header.
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'dub'
    CHECK (role IN ('dub', 'source'));

ALTER TABLE file_section_progress
  -- Buckets of the per-cell MINIMUM vote count across that cell's selected
  -- live dub takes, capped at 15, same encoding as validator_histogram. The
  -- minimum is what makes "every track is validated" a single number: min >= N
  -- iff every one of them has at least N votes. Cells with no selected dub
  -- take are absent rather than zero — they are not recorded, which is a
  -- different state from recorded-and-unvalidated.
  ADD COLUMN IF NOT EXISTS audio_validator_histogram            JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS structural_audio_validator_histogram JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The auth-worker reads the audio threshold per project on paths that must not
-- touch the settings blob — it runs to several megabytes and reading it inline
-- is what timed the org dashboard out at fifteen seconds once already.
ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS validation_count_audio TEXT
    GENERATED ALWAYS AS ((settings::jsonb)->>'validationCountAudio') STORED;


COMMIT;

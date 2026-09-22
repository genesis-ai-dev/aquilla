-- AQU-1302: park-time reflection for Autopilot runs.
--
-- When a contextual run parks, it reflects ONCE over the work it did since the
-- last reflection and proposes at most three abstracted agent memories. Two
-- pieces of durable bookkeeping make that idempotent and bounded:
--
--   reflected_at        — the watermark. Evidence gathered for the next
--                         reflection is everything the run staged, consumed or
--                         had answered AFTER this instant. NULL = never
--                         reflected, in which case the run's own created_at is
--                         the watermark, so a run that existed before this
--                         migration reflects over its whole life exactly once
--                         rather than re-proposing the same notes at every park.
--   reflected_done_spans — done_spans as of that reflection. The gate
--                         ("fewer than 2 spans since the last reflection means
--                         no reflection") is a difference against this, not a
--                         count of drafts: a single passage that staged nine
--                         cells is still one passage, and reflecting on it is
--                         the noise AQU-1300's one-span default exists to avoid.
--
-- Both are additive and defaulted, so a code-before-migration deploy keeps
-- running: the reflection step reads them, nothing else does.
ALTER TABLE contextual_runs
  ADD COLUMN IF NOT EXISTS reflected_at timestamptz,
  ADD COLUMN IF NOT EXISTS reflected_done_spans integer NOT NULL DEFAULT 0;

-- The Team thread needs ONE line per reflection ("Proposed 2 notes for
-- review"), not one per proposal. That is a new product-activity fact, so it
-- needs a place in the event vocabulary's closed CHECK. Details stay within the
-- existing allowlist (`count`); no prompt, memory path or note text is durable
-- activity.
ALTER TABLE contextual_run_events
  DROP CONSTRAINT IF EXISTS contextual_run_events_kind_check;
ALTER TABLE contextual_run_events
  ADD CONSTRAINT contextual_run_events_kind_check
  CHECK (kind IN (
    'run_created',
    'run_state',
    'span_started',
    'phase',
    'scene_ready',
    'drafts_staged',
    'span_outcome',
    'steering_queued',
    'run_command',
    'draft_reviewed',
    'memories_proposed'
  ));

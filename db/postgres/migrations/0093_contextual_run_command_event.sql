-- Migration 0093: record a run control asked for in chat as durable activity.
--
-- AQU-1299: "stop" / "pause" typed at a live Autopilot run now routes to the
-- same guarded transition the Pause/Stop buttons use, instead of being folded
-- into the next passage's drafting prompt as a steering direction. The human
-- needs to see that the command was honoured, so the command gets its own
-- activity kind, appended just before the `run_state` line the transition
-- produces.
--
-- Additive: one more value in the existing kind allowlist. The per-kind detail
-- allowlist in db/shared/contextual-runs.ts keeps this event to the control it
-- resolved to (`pause` / `stop`) — never the message text.
ALTER TABLE contextual_run_events DROP CONSTRAINT IF EXISTS contextual_run_events_kind_check;
ALTER TABLE contextual_run_events ADD CONSTRAINT contextual_run_events_kind_check CHECK (kind IN (
  'run_created',
  'run_state',
  'span_started',
  'phase',
  'scene_ready',
  'drafts_staged',
  'span_outcome',
  'steering_queued',
  'run_command',
  'draft_reviewed'
));

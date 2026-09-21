-- Migration 0093 (AQU-1300): give a contextual autopilot run a work budget.
--
-- A run had none. It walked every span in its scope — a whole file, or every
-- file under a project-wide start — in waves of up to 6, and the stranded-run
-- sweeper adopted anything that died early. A first-time user who pressed Play
-- got hundreds of drafts and was never asked whether that was wanted.
--
-- `span_allowance` is how many spans the run may still process before it parks.
-- A fresh run gets 1: draft one passage, then stop and ask. Human input on the
-- run (reviewing a draft, answering a decision, steering) grants more, and an
-- explicit Continue grants a batch. NULL means unlimited — the "translate the
-- whole file/project" choice — which is why this is nullable rather than a
-- sentinel like -1: the unlimited case is genuinely "no budget applies", and
-- arithmetic on a sentinel is how a budget silently stops being enforced.
--
-- `park_reason` splits the one `parked` status into the two states the UI has
-- to tell apart: 'awaiting_input' (allowance spent or a decision is open —
-- there IS more work, it needs a human) versus 'work_exhausted' (the scope is
-- finished). Conflating them is how "waiting for you" reads as "all done".
--
-- Both are additive and nullable. Runs already in flight when this lands keep
-- NULL: NULL allowance is unlimited, which is exactly the behaviour they
-- started under, so the deploy cannot strand or truncate a live run.
ALTER TABLE contextual_runs ADD COLUMN IF NOT EXISTS span_allowance integer;
ALTER TABLE contextual_runs ADD COLUMN IF NOT EXISTS park_reason text;

DO $$
BEGIN
  ALTER TABLE contextual_runs
    ADD CONSTRAINT contextual_runs_park_reason_check
    CHECK (park_reason IS NULL OR park_reason IN ('awaiting_input', 'work_exhausted'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

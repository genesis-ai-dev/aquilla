-- Migration 0068: persist the untrusted-content bit on agent_sessions
-- (AQU-AGENT adversarial panel authz-M2 / races-F2, FIX-A).
--
-- WHY: the within-run untrusted-content guard (memory writes disabled after a
-- tool touched untrusted artifact bytes) evaporated at run end. A follow-up run
-- on the same session started CLEAN even though the prior run left untrusted
-- content in scope, so the model could launder untrusted content into a memory
-- proposal on the next turn. We persist whether a run ended with any untrusted
-- tool use; the next run on that session initialises its guard from this flag.
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS untrusted_active boolean NOT NULL DEFAULT false;

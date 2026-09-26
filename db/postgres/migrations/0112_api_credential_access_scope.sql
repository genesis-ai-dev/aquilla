-- Migration 0112 (AQU-1242): read-only API credentials.
--
-- A PAT was all-or-nothing: every token could stage and commit changesets, so a
-- partner who only wanted an agent to REPORT on a project had to hand it the
-- same authority as one that rewrites translations. `mode` does not cover this —
-- it is the autonomy dial ('ask' needs a human at the approval page, 'act' does
-- not), and an ask-mode token still writes, just with a human in the loop.
--
-- `access` is the orthogonal question: may this token change anything at all?
--
--   'write' (default) — today's behavior: stage, commit, upload artifacts.
--   'read'            — every write surface answers scope_denied; reads work.
--
-- DEFAULT 'write' is what makes every already-minted token keep working, and
-- what makes this migration safe to apply ahead of the code that reads it.
--
-- The credential stays a CEILING, never a grant: the caller's live project role
-- is still re-resolved on every call, so a read-only token narrows what its
-- owner can do and never widens it.
ALTER TABLE api_credentials
  ADD COLUMN IF NOT EXISTS access TEXT NOT NULL DEFAULT 'write'
    CHECK (access IN ('read', 'write'));

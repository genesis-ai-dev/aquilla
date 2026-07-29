-- Migration 0070: comment thread target-text snapshot (AQU-692).
--
-- The comments drawer flags a thread "stale" ("Translation changed since this
-- thread was created") by comparing the cell's current target text against a
-- snapshot taken when the thread was created. That snapshot never had anywhere
-- to live: comment.create carried no target text and the projection had no
-- column, so the adapter hardcoded an empty string and *every* thread on a
-- translated cell showed a permanent false-positive stale badge.
--
-- Add a nullable column to hold the snapshot. comment.* stays non-chain-mutating
-- and this only touches the `comments` projection table — cells are untouched,
-- so the AD-9 cell source-staleness pin is unaffected.
--
-- NULL is the "unknown baseline" sentinel: replies, non-cell scopes, threads
-- imported from a git project, and every row that predates this migration keep
-- NULL and are never shown as stale (safe degrade), rather than being compared
-- against "" and flagged forever.

ALTER TABLE comments ADD COLUMN IF NOT EXISTS created_for_translated TEXT;

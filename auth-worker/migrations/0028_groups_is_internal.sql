-- Migration 0028: add is_internal flag to groups
-- Groups can be internal (org-private) or public (visible to all org members
-- as a pool of collaborators). The three-position filter (all / internal only /
-- public only) in the TeamsList portal reads this field client-side.
-- Default TRUE so all existing groups are treated as internal, preserving the
-- current "shows internal groups only" UX from before the toggle existed.
ALTER TABLE groups ADD COLUMN is_internal BOOLEAN NOT NULL DEFAULT TRUE;

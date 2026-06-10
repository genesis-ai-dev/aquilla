-- Migration 0033: add is_active lifecycle flag to projects
-- Projects can be toggled between active (default) and inactive.
-- Inactive = frozen-but-visible: deliberate dormancy signal for PM use-case
-- where projects are pre-created before any translator starts work.
-- DISTINCT from archived_at (Trash): archived removes the project from normal
-- listing; inactive keeps it visible but blocks edits until reactivated.
-- Default TRUE so all existing projects are treated as active on upgrade.
ALTER TABLE projects ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;

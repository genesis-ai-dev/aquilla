-- Migration: 0024_gitlab_legacy_uuid.sql
-- Description: Deterministic dedup keys for the GitLab group/subgroup → Aquilla
--   org/team migration (scripts/migrate-groups.ts).
--
-- `organizations` and `groups` use INTEGER AUTOINCREMENT primary keys, so the
-- migration's deterministic UUIDv5 (src/lib/migrate/ids.ts: orgLegacyUuidFor /
-- teamLegacyUuidFor, each seeded on the STABLE GitLab numeric group id —
-- survives renames/moves) cannot be the PK. It lives in this side column,
-- used purely as the idempotency key: a re-run finds prior rows by legacy_uuid
-- and inserts nothing.
--
-- NULL for app-created (non-migrated) orgs/groups. SQLite permits multiple NULLs
-- under a UNIQUE index, so the existing personal workspaces are unaffected.

ALTER TABLE organizations ADD COLUMN legacy_uuid TEXT;
CREATE UNIQUE INDEX idx_organizations_legacy_uuid ON organizations(legacy_uuid);

ALTER TABLE groups ADD COLUMN legacy_uuid TEXT;
CREATE UNIQUE INDEX idx_groups_legacy_uuid ON groups(legacy_uuid);

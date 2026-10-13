-- 0157_platform_admins.sql — AQU-1239
--
-- Platform admins (the cross-tenant support/oversight accounts) used to be
-- listed in the ADMIN_EMAILS var in auth-worker/wrangler.toml. The repo is now
-- public, so that list published every admin's real address. The source of
-- truth moves to this table. Deployed dev and prod stop setting ADMIN_EMAILS;
-- it stays only as an optional bootstrap for local dev, e2e, tests and
-- self-hosters.
--
-- Keyed by email, not user id, so an admin can be listed before they sign up
-- (the same behavior the env var had). Emails are stored lowercased and
-- trimmed; the CHECK refuses anything else so lookups can use the primary key.
-- `added_by` is the users.id of the admin who added the row, NULL for rows
-- inserted by hand. No foreign key: a deleted user must not block or erase the
-- record of who granted access.
--
-- This migration inserts NO rows. Add the first admins by hand with psql (see
-- docs/DEPLOYMENT-ENVIRONMENTS.md) BEFORE removing ADMIN_EMAILS from a deployed
-- environment, or nobody can open the admin console.
--
-- Idempotent. A database loaded from schema.sql already has the table.

CREATE TABLE IF NOT EXISTS platform_admins (
    email      TEXT PRIMARY KEY CHECK (email = LOWER(TRIM(email)) AND email <> ''),
    added_by   BIGINT,
    note       TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

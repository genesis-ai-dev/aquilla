-- 0198_connector_support_access.sql — AQU-2504
--
-- Connector support access: a platform admin's time-boxed, read-only reach into
-- orgs and projects they are not a member of, for support work.
--
-- The connector deliberately ignored platform-admin power (orgs-list.ts,
-- projects-list.ts and read-auth.ts all resolve membership only), so a support
-- engineer could not look at the project a customer was messaging them about.
-- This reverses that for one narrow case, and only while a window is open.
--
-- `support_access` is the GRANT — the admin ticked "support access" at connector
-- consent. `support_access_until` is the TIME BOX: cross-tenant reads work only
-- while it is in the future. Two columns rather than one because the grant has
-- to outlive the window: once it lapses the credential keeps working, member
-- scoped, exactly as a normal connector token, and the row still says what it
-- was so the window can be reopened.
--
-- Neither column grants anything on its own. db/shared/api-credentials.ts also
-- requires a live `platform_admins` row for the credential's owner on every
-- call, so removing someone from the allowlist ends their support access on the
-- next request without touching these rows.
--
-- Idempotent and additive. Existing credentials default to false/NULL, which is
-- "no support access" — the behaviour they have today.

ALTER TABLE api_credentials
  ADD COLUMN IF NOT EXISTS support_access       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS support_access_until TIMESTAMPTZ;

-- The authorization code carries the choice from consent to mint.
ALTER TABLE mcp_oauth_codes
  ADD COLUMN IF NOT EXISTS support_access BOOLEAN NOT NULL DEFAULT false;

-- A support-access code has no org picker at all ("separate from the normal org
-- picker"), so all three scope columns are NULL — which the original
-- mcp_oauth_codes_scope_check forbids (it required either a non-empty org_ids
-- array or exactly one of project_id / org_id). Widen it for that one case; the
-- other two branches are unchanged, so every existing row still satisfies it.
ALTER TABLE mcp_oauth_codes DROP CONSTRAINT IF EXISTS mcp_oauth_codes_scope_check;
ALTER TABLE mcp_oauth_codes ADD CONSTRAINT mcp_oauth_codes_scope_check CHECK (
  (org_ids IS NOT NULL AND jsonb_typeof(org_ids) = 'array'
    AND jsonb_array_length(org_ids) > 0 AND org_id IS NULL AND project_id IS NULL)
  OR (org_ids IS NULL AND ((project_id IS NULL) <> (org_id IS NULL)))
  OR (support_access AND org_ids IS NULL AND org_id IS NULL AND project_id IS NULL));

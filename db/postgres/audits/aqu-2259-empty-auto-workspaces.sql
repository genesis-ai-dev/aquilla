-- =============================================================================
-- AQU-2259 — COUNT the empty personal workspaces that page views created
-- =============================================================================
--
-- Why this exists
--   Until AQU-2259, reading "your organization" (GET /api/v2/orgs/me — asked by
--   Project settings and the members matrix — and GET /api/v2/orgs at session
--   boot) CREATED "<username>'s workspace" for anyone who owned none. Most
--   invited members got an empty organization just by opening Project settings.
--   That code is gone; this counts what it left behind, so whoever deploys can
--   decide whether to remove them. It removes NOTHING.
--
-- What counts as "empty, made this way"
--   - personal scope ('personal', or NULL for ones made before migration 0092),
--     not migrated (legacy_uuid IS NULL), and still named exactly
--     "<owner's username>'s workspace" (a renamed one is someone's choice);
--   - no project (archived ones count), no member besides the owner, no team,
--     invite, org settings row, billing, plan entitlement, API token,
--     integration, knowledge doc or org style rule.
--   `owner_in_other_org = true` rows are the Project-settings case: the owner
--   already belonged to another organization when the workspace appeared.
--
-- Safety
--   STRICTLY READ-ONLY (SELECT only). Timeouts abort rather than block writers.
--
-- How to run
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/postgres/audits/aqu-2259-empty-auto-workspaces.sql
-- =============================================================================

SET statement_timeout = '60s';
SET lock_timeout      = '2s';
SET idle_in_transaction_session_timeout = '10s';

SELECT
  COALESCE(o.billing_scope, '(null: before 0092)') AS billing_scope,
  EXISTS (
    SELECT 1 FROM org_members x WHERE x.user_id = o.owner_user_id AND x.org_id <> o.id
  ) AS owner_in_other_org,
  COUNT(*) AS empty_workspaces,
  MIN(o.created_at) AS first_created,
  MAX(o.created_at) AS last_created
FROM organizations o
JOIN users u ON u.id = o.owner_user_id
WHERE o.legacy_uuid IS NULL
  AND (o.billing_scope = 'personal' OR o.billing_scope IS NULL)
  AND o.name = u.username || '''s workspace'
  AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.org_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id AND m.user_id <> o.owner_user_id)
  AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.org_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM org_invites i WHERE i.org_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM org_settings s WHERE s.org_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM org_billing b WHERE b.org_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM workspace_plan_entitlements e WHERE e.org_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM knowledge_docs k WHERE k.org_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM style_rules r WHERE r.org_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM api_credentials a WHERE a.org_id = o.id::text)
  AND NOT EXISTS (SELECT 1 FROM integration_connections c WHERE c.org_id = o.id::text)
GROUP BY 1, 2
ORDER BY 1, 2;

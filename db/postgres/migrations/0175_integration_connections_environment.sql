-- 0175_integration_connections_environment.sql — AQU-1775
--
-- Which deployment made a Monday connection. The dev Neon branch is restored
-- from production (scripts/refresh-neon-branch.ts), and until AQU-1775 that
-- copy carried every org's encrypted Monday tokens with it. The dev identity
-- worker holds the same signing key as production (OPSEC V7/SEC-1), so it could
-- decrypt them, refresh them — rotating the refresh token out from under
-- production — and push dev's numbers onto a board linked on production.
--
-- The OAuth callback now stamps the running ENVIRONMENT on the row, and the
-- one token accessor every Monday call path goes through
-- (auth-worker/src/lib/monday/tokens.ts getConnectionAccessToken) refuses a row
-- whose environment is not its own BEFORE any decrypt or refresh. NULL means
-- "made before this column existed": production accepts it (those rows are its
-- own); every other environment refuses it, since the only way such a row
-- reaches dev is the copy.
--
-- The refresh also deletes integration_connections after restoring dev
-- (scripts/neon-scrub-integrations.ts), so the rows are normally gone before
-- the gate is ever consulted. No backfill, for the reason above.
--
-- Idempotent. A database loaded from schema.sql already has the column.

ALTER TABLE integration_connections
  ADD COLUMN IF NOT EXISTS environment TEXT;

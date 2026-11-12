-- 0158_contextual_lease_org_scope.sql — AQU-1847
--
-- Autopilot's durable capacity lease only ever had a PER-PROJECT ceiling
-- (CONTEXTUAL_MAX_CONCURRENCY, default 12 span slots ≈ 36 requests in flight
-- once the verifier panel fans out). One tenant with ten self-created projects
-- therefore multiplied that ceiling by ten and could exhaust the shared
-- provider key's rate limit for every other tenant.
--
-- The acquire statement now checks three ceilings at once: project, billing
-- workspace (org), and platform-wide. Summing per org inside that one
-- statement needs the org on the lease row, so it is denormalized here rather
-- than joined back to `projects` under the capacity lock.
--
-- Leases are short-lived (300s, renewed while a provider call is in flight) and
-- the table holds one row per in-flight wave, so backfilling existing rows is
-- pointless: anything live when this runs expires within the lease window and
-- its replacement is written with the right org. Rows that predate the column
-- simply sum into the org-0 bucket until they expire.
--
-- Idempotent. A database loaded from schema.sql already has the column.

ALTER TABLE contextual_project_leases
  ADD COLUMN IF NOT EXISTS org_id bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS contextual_project_leases_org_expiry
  ON contextual_project_leases(org_id, expires_at);

-- The platform-wide sum and the platform-wide expiry GC both scan on expiry
-- alone, with no project or org to narrow them.
CREATE INDEX IF NOT EXISTS contextual_project_leases_expiry
  ON contextual_project_leases(expires_at);

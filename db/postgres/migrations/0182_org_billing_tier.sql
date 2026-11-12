-- AQU-2059 (unified billing T3): one plan per org. Spec: docs/superpowers/specs/
-- 2026-10-19-unified-billing-meter-and-entitlements.md §4.2 and §5.1.
--
-- `tier` is the plan the resolver (db/shared/org-plan.ts) reads: free | team |
-- enterprise. It is a new column, not a rewrite of `plan`, because the legacy
-- Field code (words.ts, plans.ts, the legacy webhook and admin route) still reads
-- `plan` in its old vocabulary until the dead-code removal (T18). A NULL tier
-- falls back to the legacy `plan` mapping, so a legacy write can never strand
-- an org without a plan. Orgs with no row at all are Free.
--
-- Additive and idempotent: safe to apply before the workers that read it, and
-- safe to re-run (each backfill only fills what is still unset).
ALTER TABLE org_billing ADD COLUMN IF NOT EXISTS tier TEXT;
ALTER TABLE org_billing DROP CONSTRAINT IF EXISTS org_billing_tier_check;
ALTER TABLE org_billing ADD CONSTRAINT org_billing_tier_check
  CHECK (tier IN ('free', 'team', 'enterprise'));

-- Enterprise only. NULL = no end date. After it passes, the org gets a 14-day
-- Team-sized grace, then Free (spec Q5).
ALTER TABLE org_billing ADD COLUMN IF NOT EXISTS contract_ends_at TIMESTAMPTZ;

-- Backfill 1: legacy Field → Team, legacy Enterprise → Enterprise, the rest Free.
UPDATE org_billing SET tier = CASE plan
    WHEN 'field' THEN 'team'
    WHEN 'enterprise' THEN 'enterprise'
    ELSE 'free' END,
  updated_at = now()
WHERE tier IS NULL;

-- Backfill 2: partner-covered orgs (AQU-1212 `org_entitlements`, installed only
-- in some environments) → Enterprise, so the covered_access orgs that today get
-- no allowance are unmetered instead of refused.
DO $$
BEGIN
  IF to_regclass('public.org_entitlements') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO org_billing (org_id, tier)
      SELECT e.org_id, 'enterprise' FROM org_entitlements e
      JOIN organizations o ON o.id = e.org_id
      WHERE e.active = true
      ON CONFLICT (org_id) DO UPDATE SET tier = 'enterprise', updated_at = now()
      WHERE org_billing.tier IS DISTINCT FROM 'enterprise'
    $q$;
  END IF;
END
$$;

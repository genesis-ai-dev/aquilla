-- AQU-837: explicit workspace scope and initial paid entitlement storage.
-- No inference or backfill: legacy organizations require review before checkout.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing_scope TEXT
  CHECK (billing_scope IN ('personal', 'team'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_personal_billing_owner
  ON organizations(owner_user_id) WHERE billing_scope = 'personal';

CREATE TABLE IF NOT EXISTS workspace_plan_entitlements (
  org_id BIGINT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  offer TEXT NOT NULL CHECK (offer IN ('pro', 'max_5x', 'max_20x', 'team', 'team_20x')),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'team')),
  quantity INTEGER NOT NULL CHECK (quantity = 1),
  entitlement_version TEXT NOT NULL CHECK (entitlement_version = '2026-09-weekly'),
  price_version TEXT NOT NULL CHECK (length(price_version) > 0),
  price_ids JSONB NOT NULL CHECK (jsonb_typeof(price_ids) = 'array'),
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month', 'year')),
  usage_anchor TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scope = 'team') = (offer IN ('team', 'team_20x')))
);

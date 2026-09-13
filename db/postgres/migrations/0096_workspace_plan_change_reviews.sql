-- Immutable review facts. No subscription mutation or entitlement is implied.
CREATE TABLE IF NOT EXISTS workspace_plan_change_reviews (
  id TEXT PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES workspace_plan_entitlements(org_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('upgrade', 'downgrade')),
  source_json JSONB NOT NULL CHECK (jsonb_typeof(source_json) = 'object'),
  quote_json JSONB NOT NULL CHECK (jsonb_typeof(quote_json) = 'object'),
  request_params JSONB NOT NULL CHECK (jsonb_typeof(request_params) = 'object'),
  invoice_json JSONB,
  review_json JSONB NOT NULL CHECK (jsonb_typeof(review_json) = 'object'),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_plan_change_reviews_org
  ON workspace_plan_change_reviews (org_id, created_at);

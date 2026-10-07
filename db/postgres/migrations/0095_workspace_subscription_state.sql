-- Verified subscription facts; no change to legacy Field billing or usage anchors.
CREATE TABLE IF NOT EXISTS workspace_subscription_state (
  org_id BIGINT PRIMARY KEY REFERENCES workspace_plan_entitlements(org_id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  payment_failed BOOLEAN NOT NULL,
  paid_through TIMESTAMPTZ NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

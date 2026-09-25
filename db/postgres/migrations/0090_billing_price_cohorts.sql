-- Immutable offer assignments. This migration activates no experiments.
CREATE TABLE IF NOT EXISTS billing_price_cohorts (
  org_id BIGINT NOT NULL REFERENCES organizations(id),
  experiment_key TEXT NOT NULL,
  variant TEXT NOT NULL,
  price_version TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  exposed_at TIMESTAMPTZ,
  PRIMARY KEY (org_id, experiment_key)
);

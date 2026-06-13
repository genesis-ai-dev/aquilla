-- Org credits & unified compute-cost model (2026-06-13-org-credits-cost-model.md §Data model)
--
-- Cross-rail cost rollup: one row per (org, user, day, rail).
-- rail values: 'llm' | 'agent' | 'tts'
-- raw_cost_cents = actual infra/provider cost; credits derived on read (markup applied at query time).
-- Existing ai_usage_daily / tts_usage_daily stay as-is for their own units; this table is the $-truth.

CREATE TABLE IF NOT EXISTS org_credit_usage_daily (
  org_id         INTEGER          NOT NULL,
  user_id        INTEGER          NOT NULL,
  date_utc       DATE             NOT NULL,
  rail           TEXT             NOT NULL,
  raw_cost_cents DOUBLE PRECISION NOT NULL DEFAULT 0,
  units          INTEGER          NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, user_id, date_utc, rail)
);

CREATE INDEX IF NOT EXISTS idx_org_credit_org_date ON org_credit_usage_daily (org_id, date_utc);

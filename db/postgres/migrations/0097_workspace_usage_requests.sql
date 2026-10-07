-- AQU-837: durable, exact-period cost reservations. Prepared, not deployed.
CREATE TABLE IF NOT EXISTS workspace_usage_requests (
  org_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  user_id BIGINT NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  rail TEXT NOT NULL CHECK (rail IN ('llm', 'agent', 'tts')),
  rate_version TEXT NOT NULL CHECK (rate_version = '2026-09-cost-v1'),
  multiplier INTEGER NOT NULL CHECK (multiplier = 4),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL CHECK (period_end > period_start),
  reserved_micro_units BIGINT NOT NULL CHECK (reserved_micro_units > 0 AND reserved_micro_units <= 9007199254740991),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'settled', 'released')),
  raw_micro_cents BIGINT CHECK (raw_micro_cents >= 0 AND raw_micro_cents <= 9007199254740991),
  settled_micro_units BIGINT CHECK (settled_micro_units >= 0 AND settled_micro_units <= 9007199254740991),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  PRIMARY KEY (org_id, request_id),
  CHECK ((state = 'reserved' AND raw_micro_cents IS NULL AND settled_micro_units IS NULL AND resolved_at IS NULL)
    OR (state = 'settled' AND raw_micro_cents IS NOT NULL AND settled_micro_units = raw_micro_cents * multiplier AND resolved_at IS NOT NULL)
    OR (state = 'released' AND raw_micro_cents IS NULL AND settled_micro_units IS NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_workspace_usage_period
  ON workspace_usage_requests(org_id, period_start, period_end);

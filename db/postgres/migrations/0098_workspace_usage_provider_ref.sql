-- AQU-837: provider generation reference for reconciling held reservations.
-- Prepared, not deployed. A reference never settles usage by itself.
ALTER TABLE workspace_usage_requests
  ADD COLUMN IF NOT EXISTS provider_ref TEXT CHECK (length(provider_ref) BETWEEN 1 AND 200);
CREATE INDEX IF NOT EXISTS idx_workspace_usage_held
  ON workspace_usage_requests(org_id, created_at) WHERE state = 'reserved';

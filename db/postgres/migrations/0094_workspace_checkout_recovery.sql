-- AQU-837: keep checkout history and allow replacement only after verified expiry.
ALTER TABLE workspace_checkout_attempts ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE workspace_checkout_attempts ADD COLUMN IF NOT EXISTS resolution TEXT;
ALTER TABLE workspace_checkout_attempts DROP CONSTRAINT IF EXISTS workspace_checkout_resolution_check;
ALTER TABLE workspace_checkout_attempts ADD CONSTRAINT workspace_checkout_resolution_check
  CHECK ((resolved_at IS NULL AND resolution IS NULL)
    OR (resolved_at IS NOT NULL AND resolution IS NOT NULL AND resolution = 'expired'));
CREATE UNIQUE INDEX IF NOT EXISTS workspace_checkout_pending_org
  ON workspace_checkout_attempts (org_id) WHERE resolved_at IS NULL;
-- Install the replacement uniqueness guard before dropping the old one.
ALTER TABLE workspace_checkout_attempts DROP CONSTRAINT IF EXISTS workspace_checkout_attempts_org_id_key;

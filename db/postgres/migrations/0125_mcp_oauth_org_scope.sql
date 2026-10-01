-- AQU-1529: snapshot organization grants for OAuth; NULL retains legacy scope.
ALTER TABLE api_credentials ADD COLUMN IF NOT EXISTS org_ids JSONB;
ALTER TABLE mcp_oauth_codes ADD COLUMN IF NOT EXISTS org_ids JSONB;
ALTER TABLE api_credentials ADD CONSTRAINT api_credentials_org_ids_array
  CHECK (org_ids IS NULL OR (jsonb_typeof(org_ids) = 'array'
    AND org_id IS NULL AND project_id IS NULL));
ALTER TABLE mcp_oauth_codes DROP CONSTRAINT IF EXISTS mcp_oauth_codes_check;
ALTER TABLE mcp_oauth_codes ADD CONSTRAINT mcp_oauth_codes_scope_check
  CHECK ((org_ids IS NOT NULL AND jsonb_typeof(org_ids) = 'array'
    AND jsonb_array_length(org_ids) > 0 AND org_id IS NULL AND project_id IS NULL)
    OR (org_ids IS NULL AND ((project_id IS NULL) <> (org_id IS NULL))));

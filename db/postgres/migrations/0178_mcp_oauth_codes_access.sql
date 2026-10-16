-- Zapier OAuth (docs/ZAPIER.md): the consent page lets a pre-registered
-- client's grant be read-only. The code carries that choice to the minted
-- api_credentials row (access column from 0113). Existing codes and MCP
-- clients stay read-write, as before.
ALTER TABLE mcp_oauth_codes ADD COLUMN IF NOT EXISTS access TEXT NOT NULL DEFAULT 'write';
ALTER TABLE mcp_oauth_codes DROP CONSTRAINT IF EXISTS mcp_oauth_codes_access_check;
ALTER TABLE mcp_oauth_codes ADD CONSTRAINT mcp_oauth_codes_access_check
  CHECK (access IN ('read', 'write'));

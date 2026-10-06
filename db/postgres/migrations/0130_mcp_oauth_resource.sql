-- AQU-1584: bind OAuth credentials to MCP without changing device/PAT tokens.
ALTER TABLE api_credentials ADD COLUMN IF NOT EXISTS oauth_resource TEXT;

-- Only authorization-code credentials appear in this table. Device credentials
-- remain unbound. An old OAuth grant without an audience requires reconnection.
UPDATE api_credentials ac
SET oauth_resource = codes.resource,
    revoked_at = CASE WHEN codes.resource IS NULL THEN COALESCE(ac.revoked_at, now())
                      ELSE ac.revoked_at END
FROM mcp_oauth_codes codes
WHERE codes.credential_id = ac.id AND codes.status = 'consumed';

-- Consumed codes are retained only briefly. Expire unidentified legacy OAuth
-- org-list grants as well; they cannot safely retain their old broad audience.
UPDATE api_credentials SET revoked_at = COALESCE(revoked_at, now())
WHERE org_ids IS NOT NULL AND oauth_resource IS NULL;

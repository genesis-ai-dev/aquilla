-- 0196_langquest_connections.sql — a LangQuest token kept at the account level.
--
-- Before this, every project link held its own pasted token (0185), so linking
-- a second language from the same LangQuest organization meant pasting the
-- token again. A token still belongs to ONE person in ONE LangQuest
-- organization (it cannot be an Aquilla-org-wide integration_connections
-- row), so the connection is keyed by the Aquilla user and the LangQuest
-- organization: "this user has access to this LangQuest org".
--
--   * langquest_connections — the user's token for one LangQuest
--     organization, AES-GCM encrypted the same way as langquest_links
--     (":langquest-token" key context) and never returned by any route.
--     `needs_reauth` is set when LangQuest rejects the token (revoked,
--     expired, or made on another deployment — AQU-1775 `environment`), and
--     `last_checked_at` / `last_error` record the last health probe.
--   * langquest_links.connection_id — which connection a project link was
--     made from. The link keeps its own token_enc copy so the sync routes are
--     unchanged; reconnecting an org refreshes the copy on every link made
--     from it. ON DELETE SET NULL: disconnecting leaves the link with the
--     token it has (it may still work) rather than tearing the project's
--     import down.

CREATE TABLE IF NOT EXISTS langquest_connections (
  id               TEXT PRIMARY KEY,         -- uuid
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_base         TEXT NOT NULL,            -- e.g. https://next.langquest.org/api/v1
  lq_org_id        TEXT NOT NULL,
  lq_org_name      TEXT,
  token_enc        TEXT NOT NULL,            -- AES-GCM, base64(iv||ciphertext)
  environment      TEXT,                     -- deployment that stored the token (AQU-1775)
  token_id         TEXT,
  token_name       TEXT,
  scopes           JSONB NOT NULL DEFAULT '[]'::jsonb,
  all_languages    BOOLEAN NOT NULL DEFAULT TRUE,  -- token reaches every language of the org
  token_expires_at TIMESTAMPTZ,
  needs_reauth     BOOLEAN NOT NULL DEFAULT FALSE,
  last_checked_at  TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, lq_org_id)
);

ALTER TABLE langquest_links
  ADD COLUMN IF NOT EXISTS connection_id TEXT REFERENCES langquest_connections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_langquest_links_connection ON langquest_links(connection_id);

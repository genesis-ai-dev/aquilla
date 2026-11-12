-- 0185_langquest_links.sql — live link from an Aquilla project to a LangQuest language.
--
-- A LangQuest access token (`lqp_…`, made on next.langquest.org/connect)
-- belongs to ONE person in ONE LangQuest organization, so it cannot be an
-- org-wide integration_connections row: two projects in the same Aquilla org
-- may follow languages in different LangQuest orgs, with different people's
-- tokens. One row per project instead.
--
--   * langquest_links — the project's link. The token is AES-GCM encrypted
--     (auth-worker/src/lib/langquest/tokens.ts, ":langquest-token" key
--     context, the same MONDAY_TOKEN_KEY/SECRET_KEY material as the other
--     integrations) and never returned by any route. `environment` is the
--     AQU-1775 gate: a row copied from production onto the dev branch is
--     refused before any decrypt. `feed_cursor` is where the project has
--     read LangQuest's change feed to; NULL means "list every passage".
--   * langquest_passages — which Aquilla cell each LangQuest passage became,
--     and which version (take) of it was last imported. The sync diffs the
--     feed against this map, so a passage is created once and a new version
--     attaches one new take.
--
-- Unlinking deletes the map with the link (ON DELETE CASCADE); the imported
-- cells and their audio stay in the project.

CREATE TABLE IF NOT EXISTS langquest_links (
  project_id        TEXT PRIMARY KEY,
  token_enc         TEXT NOT NULL,          -- AES-GCM, base64(iv||ciphertext)
  environment       TEXT,                   -- deployment that stored the token (AQU-1775)
  api_base          TEXT NOT NULL,          -- e.g. https://next.langquest.org/api/v1
  lq_org_id         TEXT NOT NULL,
  lq_org_name       TEXT,
  language_id       TEXT NOT NULL,
  language_name     TEXT,
  language_code     TEXT,
  token_id          TEXT,
  scopes            JSONB NOT NULL DEFAULT '[]'::jsonb,  -- the token's scopes when linked
  can               JSONB,                  -- LangQuest's `can` for this language when linked
  token_expires_at  TIMESTAMPTZ,
  feed_cursor       TEXT,
  needs_reauth      BOOLEAN NOT NULL DEFAULT FALSE,
  last_synced_at    TIMESTAMPTZ,
  last_sync_error   TEXT,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS langquest_passages (
  project_id  TEXT NOT NULL REFERENCES langquest_links(project_id) ON DELETE CASCADE,
  unit_id     TEXT NOT NULL,
  file_id     TEXT NOT NULL,
  cell_id     TEXT NOT NULL,
  label       TEXT,
  sort_order  TEXT,
  take_id     TEXT,                         -- the LangQuest version last attached as a take
  PRIMARY KEY (project_id, unit_id)
);

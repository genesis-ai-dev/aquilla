-- Language pair as generated columns (dashboard perf follow-up).
-- settings blobs run to ~6 MB; extracting the language pair with
-- (settings::jsonb)->>'…' at read time parses that JSON on every query.
-- STORED generated columns pay the parse once at write time and can't
-- drift from the JSON. Applied by hand against Neon (see wrangler.toml).
ALTER TABLE project_settings
  ADD COLUMN source_language TEXT GENERATED ALWAYS AS ((settings::jsonb)->>'sourceLanguage') STORED,
  ADD COLUMN target_language TEXT GENERATED ALWAYS AS ((settings::jsonb)->>'targetLanguage') STORED;

-- AQU-1271: per-concept source-term matching options (mark folding, affix
-- tolerance, extra forms, excluded forms). Nullable JSON; NULL means "all
-- defaults", which is what every pre-existing concept gets. Read by the
-- concepts read route; written by term.create / term.update projection.

ALTER TABLE concepts ADD COLUMN IF NOT EXISTS match_options JSONB;

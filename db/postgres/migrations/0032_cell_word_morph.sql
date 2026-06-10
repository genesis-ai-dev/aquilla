-- Postgres migration 0032: add cell_word_morph table for Macula Hebrew + Greek import (FRO-178)
--
-- Mirrors auth-worker/migrations/0032_cell_word_morph.sql.
-- The auth-worker migration ran against SQLite (D1); this one applies the equivalent
-- change to the Neon Postgres database.
--
-- Macula imports populate this table with per-word morphology: lemma, morph code,
-- Strong's numbers. The workspace's lemma/morph hover popover reads from this table.
-- One row per word-within-verse (word_seq is 1-based within the cell).
--
-- Apply once against the Neon prod DB:
--   psql "$NEON_DATABASE_URL" -f db/postgres/migrations/0032_cell_word_morph.sql
-- or via the Neon dashboard SQL editor.
--
-- Idempotent: IF NOT EXISTS guards prevent errors on re-runs.
CREATE TABLE IF NOT EXISTS cell_word_morph (
    project_id  TEXT NOT NULL,
    file_id     TEXT NOT NULL,
    cell_id     TEXT NOT NULL,
    word_seq    INTEGER NOT NULL,   -- 1-based position within the cell
    surface     TEXT NOT NULL,      -- surface form as it appears in the text
    lemma       TEXT,               -- dictionary lemma
    morph_code  TEXT,               -- morphology code (e.g. Macula/OSHB/Robinson format)
    strongs_h   TEXT,               -- Strong's Hebrew number (e.g. H1234), NULL for Greek
    strongs_g   TEXT,               -- Strong's Greek number (e.g. G1234), NULL for Hebrew
    PRIMARY KEY (project_id, file_id, cell_id, word_seq)
);
CREATE INDEX IF NOT EXISTS idx_cell_word_morph_file ON cell_word_morph(project_id, file_id);
CREATE INDEX IF NOT EXISTS idx_cell_word_morph_lemma ON cell_word_morph(lemma) WHERE lemma IS NOT NULL;

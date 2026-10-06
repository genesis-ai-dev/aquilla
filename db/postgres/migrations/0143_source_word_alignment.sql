-- Migration 0143: source_word_alignment, Bridge 1 of the Bible data layer
-- (AQU-1694).
--
-- Who's Who (AQU-1689) knows its participant facts word by word, by Macula
-- word id. A project whose source is a gateway-language Bible has no Macula
-- ids, so a maintainer runs "Align source text to Greek" and the SPA aligns the
-- book's source cells to the Bible Knowledge Pack in a Web Worker
-- (src/lib/bible-data/source-alignment.ts). This table keeps the result, one
-- row per link: pack word `src_word_id` ↔ token `tgt_token_idx` of the source
-- cell's text (the `tokenize` order of src/lib/completion/tokenize.ts).
--
-- WHY A TABLE AND NOT AN EVENT. The rows are derived data: the source text and
-- the pack determine them, and they can be recomputed at any time. They need
-- no history, no parent chain and no conflict rule, and a book is ~15-20k
-- rows. They are written like `cell_word_morph` (0032), the other per-word
-- derived table: the client computes them and uploads them to a sync-worker
-- route (POST /api/v1/projects/:p/files/:f/source-word-alignment,
-- MAINTAINER+), which replaces a cell's rows in one transaction.
--
-- INVALIDATION. `source_hash` is the djb2 content hash of the source cell's
-- text when it was aligned, the same function that maintains
-- `cells.content_hash` (sync-worker event-projection.ts contentHash). The read
-- route joins the source row and returns a cell's links only while the two
-- hashes agree; an edited source cell reads as "stale" until the book is
-- aligned again. So no projection change is needed: a source commit never
-- has to touch this table, and a deleted cell's rows are never returned (the
-- next run for the file clears them).
--
-- `method` names the recipe ("ibm1-gdfa-names/1"), and `trained_pairs` how
-- many verse cells the run trained on: a short book's links draw dotted
-- ("approximate") whatever their confidence (see bridge-compose.ts).
--
-- RLS. None, like its sibling `cell_word_morph`, and for the reason the
-- UNCOVERED ledger in scripts/rls-coverage.test.ts gives: extending 0034's
-- policy pattern is blocked on RLS.md § Deployment status. Recorded there.
--
-- WHAT IT COSTS TO APPLY. A new, empty table: no rewrite, no backfill.
--
-- DEPLOY ORDER. Apply this migration BEFORE the sync-worker that serves the
-- route, and before the auth-worker whose agent SQL allowlist names the table
-- (READABLE_TABLES). Without the table the route answers 500 and the SPA shows
-- the alignment as unavailable; nothing else reads it. The SPA can ship any
-- time after the sync-worker.

BEGIN;
-- Give up after 5s of WAITING for a lock, as 0141 does. Creating a table takes
-- no lock on another table, so this only guards against a stuck catalog.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS source_word_alignment (
  project_id    TEXT NOT NULL,
  file_id       TEXT NOT NULL,
  cell_id       TEXT NOT NULL,
  src_word_id   TEXT NOT NULL,
  tgt_token_idx INTEGER NOT NULL CHECK (tgt_token_idx >= 0),
  conf          REAL NOT NULL CHECK (conf >= 0 AND conf <= 1),
  method        TEXT NOT NULL,
  source_hash   TEXT NOT NULL,
  trained_pairs INTEGER NOT NULL CHECK (trained_pairs >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, file_id, cell_id, src_word_id, tgt_token_idx)
);
COMMIT;

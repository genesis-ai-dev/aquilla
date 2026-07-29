-- AQU-727: "mark book done" affirmations.
--
-- A Project Lead affirms that a whole book is finished. This is a purely
-- ADVISORY sign-off — it never locks cells, blocks writes, or gates export.
-- Its only job is to make an affirmed-but-not-fully-validated book legible: the
-- UI cross-checks the affirmation against per-verse validation state and
-- surfaces every still-unvalidated verse as a punch list ("you said this book
-- is done, but these verses were never validated"). See the AQU-727 feedback.
--
-- Keyed on (project_id, book_code), NOT file_id: a book is derived at read time
-- from cells' canonical_ref (e.g. "GEN 1:1" -> book "GEN"). In most projects
-- book:file is 1:1, but 69 projects platform-wide have files that span multiple
-- books, so file_id is not a safe key for a book-level assertion.
--
-- Event-sourced (AD-2): the projection of book.affirm / book.unaffirm events.
-- affirm = INSERT ... ON CONFLICT DO UPDATE (re-affirm refreshes author + ts);
-- unaffirm = DELETE. Non-chain-mutating — no cells row is ever touched.

CREATE TABLE IF NOT EXISTS book_affirmations (
    project_id    TEXT NOT NULL,
    book_code     TEXT NOT NULL,
    -- Frontier user id of the lead who affirmed (INTEGER, matching created_by
    -- on assignments); the username label is kept alongside for display so the
    -- read path never has to join the users table.
    affirmed_by   BIGINT NOT NULL,
    affirmed_by_label TEXT NOT NULL,
    -- The book.affirm event id + server clock that produced this row (audit).
    event_id      TEXT NOT NULL,
    affirmed_at   BIGINT NOT NULL,
    note          TEXT,
    PRIMARY KEY (project_id, book_code)
);

CREATE INDEX IF NOT EXISTS idx_book_affirmations_project
  ON book_affirmations(project_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE book_affirmations TO app_runtime;

ALTER TABLE book_affirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE book_affirmations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_book_affirmations_project_access ON book_affirmations;
CREATE POLICY rls_book_affirmations_project_access ON book_affirmations
  AS PERMISSIVE
  FOR ALL
  TO app_runtime
  USING (app_user_can_access_project(project_id));

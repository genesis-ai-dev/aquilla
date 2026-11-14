-- 0204_cell_audio_cut_votes.sql — AQU-2492: undoing a cut keeps the approvals.
--
-- A cut keeps the take's id on its first piece, and an audio vote is keyed by
-- take id, so the take's approvals and its first piece's approvals cannot both
-- live in `cell_audio_validators`. `cell.audio.cut` used to DELETE the take's
-- votes, and undoing the cut gave nothing back (Sam, Nov 9: "I would like an
-- approved cut to still be undoable. We just need to remember the approval for
-- if the cut is redone").
--
-- Each swap now archives the votes it takes off the piece here, keyed by the
-- event that took them, the way `removed_cell_archive` (0178) keeps what a row
-- removal took:
--   - `cell.audio.cut` archives the take's votes as kind 'whole';
--   - `cell.audio.uncut` (its Undo) archives the first piece's votes as kind
--     'first' and puts the newest 'whole' archive of that cut back;
--   - the Redo (a cut naming the piece the undo removed) archives 'whole'
--     again and puts the newest 'first' archive back.
-- The cut's second piece needs no row: an undo soft-deletes it, and a removed
-- take keeps its votes until it is brought back.
--
--   piece_id      the cut's second piece: names the cut.
--   audio_id      the piece the cut was made in (it keeps the first half).
--   url           the audio the votes were given to; an archive comes back
--                 only while the take still plays it (AQU-1571).
--   votes         the `cell_audio_validators` rows, as to_jsonb, exactly.
--   archived_seq  the archiving event's server_seq: a restore takes the
--                 newest archive written BEFORE its own event, so a rebuild
--                 picks the one the live write did.
--   gain_db, fade_in_ms, fade_out_ms
--                 the piece's volume and fades (0193) as they were, read
--                 before the cut changed anything: undoing a cut gives the
--                 whole take its level back, and a Redo is refused once the
--                 joined take's level changed since (review finding 7).
--
-- Written ONCE (ON CONFLICT DO NOTHING), and only by the live write: a
-- projection rebuild replays these events against today's state, writes no
-- archive, and the live copy is the truth. Written and read only by the
-- sync-worker's projection; no app read path touches it.
-- Idempotent; a database loaded from schema.sql already has it.
--
-- Numbered 0204: the next free number on dev at its PR step (dev ends at 0203).

CREATE TABLE IF NOT EXISTS cell_audio_cut_votes (
    event_id      TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    file_id       TEXT NOT NULL,
    cell_id       TEXT NOT NULL,
    piece_id      TEXT NOT NULL,
    audio_id      TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('whole', 'first')),
    url           TEXT,
    votes         JSONB NOT NULL DEFAULT '[]'::jsonb,
    archived_seq  BIGINT,
    archived_ts   BIGINT NOT NULL,
    gain_db       REAL,
    fade_in_ms    BIGINT,
    fade_out_ms   BIGINT
);

-- The level columns arrived after the first draft of this file: a database
-- that created the table from that draft gets them here.
ALTER TABLE cell_audio_cut_votes ADD COLUMN IF NOT EXISTS gain_db REAL;
ALTER TABLE cell_audio_cut_votes ADD COLUMN IF NOT EXISTS fade_in_ms BIGINT;
ALTER TABLE cell_audio_cut_votes ADD COLUMN IF NOT EXISTS fade_out_ms BIGINT;

CREATE INDEX IF NOT EXISTS idx_cell_audio_cut_votes_cut
    ON cell_audio_cut_votes (project_id, file_id, cell_id, piece_id, kind);

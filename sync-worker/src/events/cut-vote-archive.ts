// AQU-2492 (review, Nov 9; Sam's call the same day): undoing a cut keeps the
// approvals. His words: "I would like an approved cut to still be undoable.
// We just need to remember the approval for if the cut is redone (not
// manually, but with a redo button)."
//
// A cut keeps the take's id on its first piece, and a vote is keyed by take
// id, so the take's approvals and its first piece's approvals cannot both
// live in `cell_audio_validators`. The cut used to DELETE the take's votes,
// and undoing it gave nothing back. Now each swap ARCHIVES the votes it takes
// off the piece, here, keyed by the event that took them:
//
//   - `cell.audio.cut` archives the take's votes as kind 'whole';
//   - `cell.audio.uncut` (the Undo) archives the first piece's votes as kind
//     'first', and puts the newest 'whole' archive of that cut back;
//   - the Redo (`cell.audio.cut` naming the removed piece again) archives the
//     take's votes as 'whole' again, and puts the newest 'first' archive back.
//
// The cut's second piece needs nothing here: an undo soft-deletes it, and a
// removed take keeps its votes, so they are live again when the Redo brings
// it back — the same way undoing a take's deletion does.
//
// THE SAME RULES AS `removed_cell_archive` (removed-cell-archive.ts). Only
// rows that really were in `cell_audio_validators` are archived, by the
// projection itself, and a restore re-inserts them exactly — the voter's own
// username, the time they voted, the lane. No client sends a vote here.
// Written ONCE (ON CONFLICT DO NOTHING): a projection rebuild replays these
// events against today's state, and the live copy is the truth. A restore
// reads the newest archive written BEFORE its own event (by `server_seq`), so
// a rebuild picks the same archive the live write did. And a vote is pinned to
// the audio it was given to: an archive comes back only while the take still
// plays the same recording (AQU-1571: a take whose audio was swapped loses its
// votes).

import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'

/** What the archive is of: the take before the cut, or its first piece when the cut was undone. */
export type CutVoteKind = 'whole' | 'first'

interface ArchivingEvent {
  id: string
  projectId: string
  fileId: string
  cellId: string
  serverTs: number
  /** Set on a replay (rebuild); a live write reads it off its own events row. */
  serverSeq?: number
}

/** The event's place in the log: its seq, read off its events row on a live write. Two binds. */
const EVENT_SEQ_SQL = `COALESCE(?::bigint, (SELECT e.server_seq FROM events e WHERE e.id = ?))`
const eventSeqBinds = (event: ArchivingEvent) => [event.serverSeq ?? null, event.id]

/**
 * Archive the live votes on `audioId` (the piece the cut was made in) under
 * this event, as `kind`, with the audio they were given to. Runs only when
 * `gate` holds (an SQL condition, `AND`-joined).
 */
export function cutVoteArchiveStmt(
  db: AquillaDb,
  event: ArchivingEvent,
  opts: { pieceId: string; audioId: string; kind: CutVoteKind; gate: string; gateBinds: readonly unknown[] },
): AquillaStatement {
  return db
    .prepare(
      `INSERT INTO cell_audio_cut_votes
         (event_id, project_id, file_id, cell_id, piece_id, audio_id, kind, url, votes, archived_seq, archived_ts)
       SELECT ?, a.project_id, a.file_id, a.cell_id, ?, a.audio_id, ?, a.url,
              COALESCE((SELECT jsonb_agg(to_jsonb(v)) FROM cell_audio_validators v
                         WHERE v.project_id = a.project_id AND v.file_id = a.file_id
                           AND v.cell_id = a.cell_id AND v.audio_id = a.audio_id), '[]'::jsonb),
              ${EVENT_SEQ_SQL}, ?
         FROM cell_audio a
        WHERE a.project_id = ? AND a.file_id = ? AND a.cell_id = ? AND a.audio_id = ?
          AND ${opts.gate}
       ON CONFLICT (event_id) DO NOTHING`,
    )
    .bind(
      event.id,
      opts.pieceId,
      opts.kind,
      ...eventSeqBinds(event),
      event.serverTs,
      event.projectId,
      event.fileId,
      event.cellId,
      opts.audioId,
      ...opts.gateBinds,
    )
}

/**
 * Put back on `audioId` the votes of the newest `kind` archive of this cut
 * (named by `pieceId`) written before this event — only while the take still
 * plays the audio they were given to, and only when `gate` holds. A vote the
 * take has again already is left as it is.
 */
export function cutVoteRestoreStmt(
  db: AquillaDb,
  event: ArchivingEvent,
  opts: { pieceId: string; audioId: string; kind: CutVoteKind; gate: string; gateBinds: readonly unknown[] },
): AquillaStatement {
  return db
    .prepare(
      `INSERT INTO cell_audio_validators (project_id, file_id, cell_id, audio_id, username, decided_ts, lane_id)
       SELECT r.project_id, r.file_id, r.cell_id, r.audio_id, r.username, r.decided_ts, r.lane_id
         FROM (SELECT x.votes, x.url FROM cell_audio_cut_votes x
                WHERE x.project_id = ? AND x.file_id = ? AND x.cell_id = ?
                  AND x.piece_id = ? AND x.audio_id = ? AND x.kind = ?
                  AND COALESCE(x.archived_seq < ${EVENT_SEQ_SQL}, x.archived_ts < ?)
                ORDER BY x.archived_seq DESC NULLS LAST, x.archived_ts DESC, x.event_id DESC
                LIMIT 1) arch
         JOIN cell_audio a
           ON a.project_id = ? AND a.file_id = ? AND a.cell_id = ? AND a.audio_id = ?
          AND a.url IS NOT DISTINCT FROM arch.url
        CROSS JOIN LATERAL jsonb_populate_recordset(NULL::cell_audio_validators, arch.votes) AS r
        WHERE r.project_id = a.project_id AND r.file_id = a.file_id AND r.cell_id = a.cell_id
          AND r.audio_id = a.audio_id
          AND ${opts.gate}
       ON CONFLICT (project_id, file_id, cell_id, audio_id, username) DO NOTHING`,
    )
    .bind(
      event.projectId,
      event.fileId,
      event.cellId,
      opts.pieceId,
      opts.audioId,
      opts.kind,
      ...eventSeqBinds(event),
      event.serverTs,
      event.projectId,
      event.fileId,
      event.cellId,
      opts.audioId,
      ...opts.gateBinds,
    )
}

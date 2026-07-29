// Handler for the book.affirm / book.unaffirm event family (AQU-727 —
// "mark book done").
//
// Book affirmations are PROJECT-level and non-chain-mutating: they never move
// any cell's event_id chain head. Like assignment.* / comment.*, the event
// carries a fileId on the envelope for auth/routing (the lead emits through a
// file-scoped sync token), but the affirmed unit is a BOOK (book_code), keyed
// project-wide in the payload — a book can span files and a file can span books,
// so file_id is deliberately not the key.
//
//   book.affirm    : UPSERT one book_affirmations row per (project_id, book_code).
//                    A re-affirm refreshes affirmed_by / affirmed_at / note
//                    idempotently (ON CONFLICT DO UPDATE).
//   book.unaffirm  : DELETE the (project_id, book_code) row (withdraw sign-off).
//
// The affirmation is purely ADVISORY — it locks nothing and gates nothing. It
// exists only so the read/UI layer can cross-check an affirmed book against its
// per-verse validation state and surface the still-unvalidated verses.

import type { AuthorizedEvent } from '../authorize'
import type { RealtimeMessage, ProjectionTable } from '../realtime'
import type { EventKind, EventPayloads } from '../types'
import { buildEventInsertStmt } from '../event-insert'
import type { DispatchResult } from './types'

export type BookAffirmEventKind = Extract<EventKind, 'book.affirm' | 'book.unaffirm'>

export function handleBookAffirmEvent(
  db: AquillaDb,
  authed: AuthorizedEvent<BookAffirmEventKind>,
  serverTs: number,
): DispatchResult {
  const { event, claims } = authed

  // Canonical events row (history/audit). server_seq is allocated by the
  // per-project counter inside the INSERT — see events/event-insert.ts.
  const eventInsert = buildEventInsertStmt(db, {
    id: event.id,
    schemaVersion: event.schemaVersion,
    projectId: event.projectId,
    fileId: event.fileId ?? null,
    cellId: event.cellId ?? null,
    parentId: event.parentId ?? null,
    kind: event.kind,
    author: claims.username,
    payloadJson: JSON.stringify(event.payload),
    clientTs: event.clientTs,
    serverTs,
  })

  const stmts: AquillaStatement[] = [eventInsert]
  const dirtyTables: ProjectionTable[] = ['events', 'book_affirmations']

  if (event.kind === 'book.affirm') {
    const p = event.payload as EventPayloads['book.affirm']
    stmts.push(
      db
        .prepare(
          `INSERT INTO book_affirmations (
             project_id, book_code, affirmed_by, affirmed_by_label,
             event_id, affirmed_at, note
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, book_code) DO UPDATE SET
             affirmed_by       = excluded.affirmed_by,
             affirmed_by_label = excluded.affirmed_by_label,
             event_id          = excluded.event_id,
             affirmed_at       = excluded.affirmed_at,
             note              = excluded.note`,
        )
        .bind(
          event.projectId,
          p.bookCode,
          claims.userId,
          claims.username,
          event.id,
          serverTs,
          p.note ?? null,
        ),
    )
  } else {
    // book.unaffirm — withdraw the sign-off.
    const p = event.payload as EventPayloads['book.unaffirm']
    stmts.push(
      db
        .prepare(
          `DELETE FROM book_affirmations
           WHERE project_id = ? AND book_code = ?`,
        )
        .bind(event.projectId, p.bookCode),
    )
  }

  const eventFrame: Extract<RealtimeMessage, { t: 'event' }> = {
    v: 1,
    t: 'event',
    id: event.id,
    kind: event.kind,
    project: event.projectId,
    file: event.fileId,
    ts: serverTs,
  }

  return { stmts, eventFrame, dirtyTables }
}

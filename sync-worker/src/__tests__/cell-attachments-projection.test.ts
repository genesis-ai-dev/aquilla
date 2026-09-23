// AQU-777: the `cell.attachment.*` projection.
//
// Four properties are load-bearing and are what this file pins:
//   - the INSERT conflicts on the PROJECT-SCOPED key, so one project claiming
//     an attachment id cannot swallow another project's row (the AQU-1296
//     lesson `comments` learned the hard way);
//   - re-delivering the same event is a no-op, which is what makes an outbox
//     retry harmless;
//   - a removal is a SOFT delete, so it replays from the log and the R2 key
//     stays discoverable for an orphan sweep;
//   - removal carries NO author gate, so a contributor can clear a teammate's
//     wrong screenshot off a cell.
//
// It also pins the producer→consumer contract across the SPA/worker seam: the
// payload built below is the one `attachFileToCell` emits (client-side
// uuidv7 attachmentId, `<id>.<ext>` objectName, the picked filename, the
// VALIDATED content type), not a hand-tuned fixture. A parser test plus a
// synthetic projection test would not catch the two drifting apart.

import { describe, it, expect } from 'vitest'
import {
  buildEventProjectionStmts,
  isChainMutatingKind,
  type PersistedEvent,
} from '../events/event-projection'
import { REQUIRED_ROLE, ROLE } from '../events/role-policy'
import type { EventKind, EventPayloads } from '../events/types'

interface RecordedStmt {
  sql: string
  args: unknown[]
}

function makeRecordingDb() {
  const recorded: RecordedStmt[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          recorded.push({ sql: sql.replace(/\s+/g, ' ').trim(), args })
          return this
        },
      } as unknown as AquillaStatement
    },
  } as unknown as AquillaDb
  return { db, recorded }
}

function makeEvent<K extends EventKind>(
  kind: K,
  payload: EventPayloads[K],
  over: Partial<PersistedEvent<K>> = {},
): PersistedEvent<K> {
  return {
    id: 'evt-1',
    schemaVersion: 1,
    projectId: 'proj-1',
    fileId: 'file-gen',
    cellId: 'GEN 1:1',
    parentId: null,
    kind,
    author: 'ana',
    payload,
    clientTs: 1000,
    serverTs: 2000,
    serverSeq: 9,
    ...over,
  } as PersistedEvent<K>
}

/**
 * The payload `attachFileToCell` produces for a picked PNG. Field for field:
 * `attachmentId` is a client uuidv7, `objectName` is that id plus the
 * extension derived from the VALIDATED mime type, `name` is the picked
 * filename verbatim, and `sizeBytes` is the file's own size.
 */
const ATTACHMENT_ID = '0198abc1-2345-7def-89ab-0123456789ab'
const addPayload = (
  over: Partial<EventPayloads['cell.attachment.add']> = {},
): EventPayloads['cell.attachment.add'] => ({
  attachmentId: ATTACHMENT_ID,
  objectName: `${ATTACHMENT_ID}.png`,
  name: 'chapter-3-layout.png',
  mimeType: 'image/png',
  sizeBytes: 20_480,
  ...over,
})

function project<K extends EventKind>(event: PersistedEvent<K>) {
  const { db, recorded } = makeRecordingDb()
  const touches = buildEventProjectionStmts(db, event, [])
  return { touches, recorded }
}

describe('cell.attachment.add', () => {
  it('inserts the row the client described, keyed by (project, attachment)', () => {
    const { touches, recorded } = project(makeEvent('cell.attachment.add', addPayload()))

    expect(touches).toEqual(['cell_attachments'])
    expect(recorded).toHaveLength(1)
    const [stmt] = recorded
    expect(stmt.sql).toContain('INSERT INTO cell_attachments')
    // The conflict target must be project-scoped. Conflicting on
    // attachment_id alone is what let the first project to claim an id own
    // the only row that could ever exist (AQU-1296 on `comments`).
    expect(stmt.sql).toContain('ON CONFLICT(project_id, attachment_id) DO NOTHING')
    expect(stmt.args).toEqual([
      'proj-1',
      ATTACHMENT_ID,
      'file-gen',
      'GEN 1:1',
      `${ATTACHMENT_ID}.png`,
      'chapter-3-layout.png',
      'image/png',
      20_480,
      'ana',
      'ana',
      2000, // server clock, never the client's
      'evt-1',
    ])
  })

  it('stamps the SERVER timestamp, not the client-supplied one', () => {
    const { recorded } = project(
      makeEvent('cell.attachment.add', addPayload(), { clientTs: 1, serverTs: 777 }),
    )
    expect(recorded[0].args).toContain(777)
    expect(recorded[0].args).not.toContain(1)
  })

  it('writes NULLs for the optional metadata rather than dropping columns', () => {
    // A mobile browser can report no type at all. The row still has to land —
    // with nulls the reader can branch on, not a short INSERT.
    const { recorded } = project(
      makeEvent(
        'cell.attachment.add',
        { attachmentId: 'a2', objectName: 'a2.bin', name: 'scan' },
      ),
    )
    expect(recorded[0].args).toEqual([
      'proj-1', 'a2', 'file-gen', 'GEN 1:1', 'a2.bin', 'scan',
      null, null, 'ana', 'ana', 2000, 'evt-1',
    ])
  })

  it('throws when the envelope is missing the cell it hangs off', () => {
    expect(() =>
      project(makeEvent('cell.attachment.add', addPayload(), { cellId: null })),
    ).toThrow(/missing fileId or cellId/)
    expect(() =>
      project(makeEvent('cell.attachment.add', addPayload(), { fileId: null })),
    ).toThrow(/missing fileId or cellId/)
  })
})

describe('cell.attachment.remove', () => {
  it('soft-deletes — the row survives so the removal replays', () => {
    const { touches, recorded } = project(
      makeEvent('cell.attachment.remove', { attachmentId: ATTACHMENT_ID }),
    )
    expect(touches).toEqual(['cell_attachments'])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].sql).toContain('UPDATE cell_attachments SET deleted_at = ?')
    expect(recorded[0].sql).not.toContain('DELETE FROM')
    // Project-scoped match, for the same reason the insert's conflict is.
    expect(recorded[0].sql).toContain('project_id = ? AND attachment_id = ?')
    expect(recorded[0].args).toEqual([2000, 'proj-1', ATTACHMENT_ID])
  })

  it('is idempotent — a re-delivery cannot re-stamp a settled deleted_at', () => {
    const { recorded } = project(
      makeEvent('cell.attachment.remove', { attachmentId: ATTACHMENT_ID }),
    )
    expect(recorded[0].sql).toContain('deleted_at IS NULL')
  })

  it('does NOT gate on the author — a contributor may clear a teammate’s file', () => {
    // Unlike comment.delete, which pairs a self floor with a higher foreign
    // one. AQU-777 asks for removal by "a user with edit access", and a
    // contributor who cannot take down someone else's wrong screenshot is
    // stuck. Pinned because the natural thing to copy here is comment.delete.
    const { recorded } = project(
      makeEvent(
        'cell.attachment.remove',
        { attachmentId: ATTACHMENT_ID },
        { author: 'someone-else', callerRole: ROLE.CONTRIBUTOR },
      ),
    )
    expect(recorded[0].sql).not.toContain('author_id')
    expect(recorded[0].args).not.toContain('someone-else')
  })
})

describe('classification', () => {
  it('is non-chain-mutating — an attachment never moves the cell’s text chain', () => {
    expect(isChainMutatingKind('cell.attachment.add')).toBe(false)
    expect(isChainMutatingKind('cell.attachment.remove')).toBe(false)
  })

  it('sits on the CONTRIBUTOR floor, like the other per-cell blob write', () => {
    expect(REQUIRED_ROLE['cell.attachment.add']).toBe(ROLE.CONTRIBUTOR)
    expect(REQUIRED_ROLE['cell.attachment.remove']).toBe(ROLE.CONTRIBUTOR)
    // Same bar as attaching audio to a cell — not the COMMENTER bar comments
    // sit on. Attaching reference material is editing the cell's context.
    expect(REQUIRED_ROLE['cell.attachment.add']).toBe(REQUIRED_ROLE['cell.audio.attach'])
  })
})

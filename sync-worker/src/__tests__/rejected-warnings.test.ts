// AQU-1571 — a refused event in an Agent API commit receipt names the file and
// line it targeted, so an agent can tell which item the perimeter refused.

import { describe, it, expect } from 'vitest'
import { PROJECT_SENTINEL_FILE_ID } from '../events/authorize'
import { locateEvents, locateRejections, rejectedWarnings } from '../external/rejected-warnings'

const sent = [
  { id: 'e-cell', fileId: 'file-1', cellId: 'cell-7' },
  { id: 'e-file', fileId: 'file-2' },
  { id: 'e-comment', fileId: PROJECT_SENTINEL_FILE_ID },
  { id: 'e-term', fileId: PROJECT_SENTINEL_FILE_ID, cellId: undefined },
]

describe('locateEvents', () => {
  it('maps each event id to its file and cell, blank where the event has none', () => {
    const where = locateEvents(sent)
    expect(where.get('e-cell')).toEqual({ fileId: 'file-1', cellId: 'cell-7' })
    expect(where.get('e-file')).toEqual({ fileId: 'file-2', cellId: '' })
  })

  it('never reports the internal project sentinel as a file', () => {
    const where = locateEvents(sent)
    expect(where.get('e-comment')).toEqual({ fileId: '', cellId: '' })
    expect(where.get('e-term')).toEqual({ fileId: '', cellId: '' })
  })
})

describe('rejectedWarnings', () => {
  it('names the refused line and keeps the message text as before', () => {
    const where = locateEvents(sent)
    expect(
      rejectedWarnings([{ id: 'e-cell', status: 403, reason: 'self-validation is not allowed' }], where),
    ).toEqual([
      {
        code: 'rejected',
        fileId: 'file-1',
        cellId: 'cell-7',
        message: 'e-cell: self-validation is not allowed',
      },
    ])
  })

  it('leaves an id it never sent blank instead of guessing', () => {
    expect(rejectedWarnings([{ id: 'ghost', status: 409, reason: 'x' }], locateEvents(sent))).toEqual([
      { code: 'rejected', fileId: '', cellId: '', message: 'ghost: x' },
    ])
  })

  it('returns nothing when nothing was refused', () => {
    expect(rejectedWarnings([], locateEvents(sent))).toEqual([])
  })
})

describe('locateRejections', () => {
  it('keeps the perimeter fields and adds the location', () => {
    const where = locateEvents(sent)
    expect(
      locateRejections(
        [
          { id: 'e-cell', status: 403, reason: 'nope' },
          { id: 'e-comment', status: 403, reason: 'floor' },
        ],
        where,
      ),
    ).toEqual([
      { id: 'e-cell', status: 403, reason: 'nope', fileId: 'file-1', cellId: 'cell-7' },
      { id: 'e-comment', status: 403, reason: 'floor', fileId: '', cellId: '' },
    ])
  })
})

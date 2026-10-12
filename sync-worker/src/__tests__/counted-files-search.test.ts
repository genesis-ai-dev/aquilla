// AQU-1626 — search and term mining skip deleted files and hidden companions.
//
// The sibling half of the dashboard fix. Two `files.role` values mark a HIDDEN
// companion the importer creates to hold machinery rather than translatable
// text: `audio-cues` (the cue sheet a dub records against) and
// `timeline-content` (a linked video's caption track). Both can run to hundreds
// of rows of timecode, and both were full participants in project search — so
// looking for a phrase in a dubbed episode returned pages of machine rows above
// the script, and Find & Replace, whose candidate list IS those results, would
// happily rewrite a timecode nobody was editing.
//
// A tombstoned file is the same bug with a different cause: deleting a file took
// its rows out of the editor but left them searchable.
//
// The predicate under test (`inCountedFileSql`) is an ANTI-join, so a cell whose
// `files` row is missing stays searchable — the last test here pins that,
// because the opposite direction would make every fixture (and any projection
// that has a cell before its file) silently lose its text.
import { describe, it, expect } from 'vitest'
import { makeTestDb } from './helpers/pg-test-db'
import {
  makeVerifiedProjectId,
  queryScopedSearch,
  queryScopedExact,
} from '../events/scoped-search'
import { loadVisibleSourceTexts } from '../events/concept-occurrences'
import type { SyncTokenClaims } from '../auth'

const PROJECT = 'proj-counted'
const claims = { projectId: PROJECT } as SyncTokenClaims

/** A source row carrying the searched-for word, in `fileId`. */
function sourceCell(fileId: string, cellId: string, value: string) {
  return {
    project_id: PROJECT, file_id: fileId, cell_id: cellId, side: 'source',
    target_lang: '', type: 'verse', value,
    canonical_ref: `GEN 1:${cellId}`, event_id: `e-${fileId}-${cellId}`,
    last_editor: 'alice', last_edit_at: 1, validated: 0, endorsement_count: 0,
    word_count: 2, hidden_at: null, tombstoned_at: null,
  }
}

/**
 * One ordinary file plus the three kinds of file that must not contribute: a
 * tombstone and the two hidden roles. Every one of them contains the word.
 */
function fixture() {
  return makeTestDb({
    files: [
      { id: 'f-script', project_id: PROJECT, name: 'Episode 1', event_id: 'fe1' },
      { id: 'f-gone', project_id: PROJECT, name: 'Deleted draft', event_id: 'fe2', deleted_at: 1_700_000_000_000 },
      { id: 'f-cues', project_id: PROJECT, name: 'Episode 1 · audio cues', event_id: 'fe3', role: 'audio-cues' },
      { id: 'f-track', project_id: PROJECT, name: 'Episode 1 · captions', event_id: 'fe4', role: 'timeline-content' },
    ],
    cells: [
      sourceCell('f-script', 'c1', 'the quokka speaks'),
      sourceCell('f-gone', 'c2', 'the quokka speaks'),
      sourceCell('f-cues', 'c3', 'the quokka speaks'),
      sourceCell('f-track', 'c4', 'the quokka speaks'),
    ],
  })
}

describe('AQU-1626 — search skips deleted files and hidden companions', () => {
  it('returns only the hit in the real file', async () => {
    const t = await fixture()
    const project = makeVerifiedProjectId(claims)
    expect((await queryScopedSearch(t.db, project, 'quokka', {})).map((h) => h.fileId)).toEqual(['f-script'])
    // The exact-phrase form backs Find & Replace, which WRITES to what it
    // finds — so a cue sheet reaching this list is a corruption risk, not just
    // noise.
    expect((await queryScopedExact(t.db, project, 'the quokka speaks', {})).map((h) => h.fileId)).toEqual(['f-script'])
  })

  it('mines suggested terminology from the real file alone', async () => {
    const t = await fixture()
    const { texts } = await loadVisibleSourceTexts(t.db, PROJECT)
    expect(texts).toEqual(['the quokka speaks'])
  })

  it('still searches a cell whose file row is missing', async () => {
    // The anti-join direction, pinned: absent is not the same as uncounted.
    const t = await makeTestDb({
      files: [],
      cells: [sourceCell('f-orphan', 'c1', 'the quokka speaks')],
    })
    const hits = await queryScopedSearch(t.db, makeVerifiedProjectId(claims), 'quokka', {})
    expect(hits.map((h) => h.fileId)).toEqual(['f-orphan'])
  })
})

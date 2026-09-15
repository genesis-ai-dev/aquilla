// AQU-1068: everything a USFM export needs to know about one file, in one
// place, because TWO routes need it and used to carry the same SQL twice.
//
// `export-route.ts` (one file) and `export-bundle-route.ts` (a project zip)
// held character-for-character identical copies of the overrides query and its
// Map assembly, with nothing enforcing the duplication. This module is that
// shared piece, now that the answer has three parts rather than one:
//
//   - TRANSLATIONS, keyed by verse address, exactly as before.
//   - ADDITIONS: content somebody added in the app. It has no verse number of
//     its own — Ryder's rule is that nothing renumbers — so it rides the verse
//     it follows, appended to that verse's text.
//   - REMOVALS: verses somebody deleted. Without these every removal is
//     silently undone at export, because a removed cell and an untranslated one
//     look identical from here: both simply have no translation, and the
//     serializer's job is to leave the client's original words alone.
//
// ORDER OF QUERIES IS LOAD-BEARING FOR THE TESTS. `export-route.test.ts` stubs
// the database and used to route by prepare-call ORDINAL. That stub now routes
// on SQL text, but the translations query still runs first here so the change
// stays reviewable against the old shape.

import { removedCellsForFile } from './removed-cells'
import type { UsfmEdits } from '../lib/usfm-lossless'

/** How far an added cell may sit from a verse before we give up walking. Two
 *  cells added in a row chain through each other, so a handful of hops is
 *  normal; a hundred means the chain is broken or cyclic and the right answer
 *  is to place nothing rather than to guess. */
const MAX_ANCHOR_HOPS = 100

export interface UsfmExportPlan {
  /** Verse address -> translated text. */
  overrides: Map<string, string>
  /** What the editor did to the file's structure. */
  edits: UsfmEdits
}

interface AddedCellRow {
  cell_id: string
  anchor_cell_id: string | null
  value: string | null
}

interface AnchorRow {
  cell_id: string
  anchor_cell_id: string | null
  canonical_ref: string | null
}

export async function buildUsfmExportPlan(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  lane: string,
): Promise<UsfmExportPlan> {
  // 1. Translations. Every target cell paired with a source cell that has a
  //    canonical_ref (the verse address). The projection writes canonical_ref
  //    ONLY on the source side; the target side is paired by
  //    (project_id, file_id, cell_id) and inherits its addressability.
  const cells = await db
    .prepare(
      `SELECT s.canonical_ref AS canonical_ref, t.value AS value
         FROM cells t
         JOIN cells s
           ON s.project_id = t.project_id
          AND s.file_id    = t.file_id
          AND s.cell_id    = t.cell_id
          AND s.side       = 'source'
          AND s.target_lang = ''
        WHERE t.project_id = ?
          AND t.file_id    = ?
          AND t.side       = 'target'
          AND t.target_lang = ?
          AND s.canonical_ref IS NOT NULL
          AND t.value <> ''`,
    )
    .bind(projectId, fileId, lane)
    .all<{ canonical_ref: string; value: string }>()

  const overrides = new Map<string, string>()
  for (const row of cells.results ?? []) overrides.set(row.canonical_ref, row.value)

  const edits: UsfmEdits = {}

  // 2. Additions. Everything beyond this point is best-effort: a failure must
  //    degrade to today's behaviour (a correct file missing the new content)
  //    rather than lose the whole download.
  try {
    const appendAfter = await resolveAdditions(db, projectId, fileId, lane)
    if (appendAfter.size > 0) edits.appendAfter = appendAfter
  } catch {
    // leave additions out
  }

  // 3. Removals. Only a cell that HAD a verse address can be dropped from the
  //    file — one added in the app was never in it, so there is nothing to
  //    remove, which is why the null refs fall away here.
  const removedRefs = new Set<string>()
  for (const removed of await removedCellsForFile(db, projectId, fileId)) {
    if (removed.canonicalRef) removedRefs.add(removed.canonicalRef)
  }
  if (removedRefs.size > 0) edits.remove = removedRefs

  return { overrides, edits }
}

/**
 * Added cells that have a translation, grouped under the verse each follows.
 *
 * An added cell with no translation contributes nothing (Sam, 2026-09-09): the
 * native export writes translations into the client's file, and there is
 * nothing to write. That matches what already happens to an imported paragraph
 * with no translation, which simply keeps the client's own words.
 */
async function resolveAdditions(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  lane: string,
): Promise<Map<string, readonly string[]>> {
  const added = await db
    .prepare(
      `SELECT s.cell_id AS cell_id, s.anchor_cell_id AS anchor_cell_id, t.value AS value
         FROM cells s
         LEFT JOIN cells t
           ON t.project_id = s.project_id
          AND t.file_id    = s.file_id
          AND t.cell_id    = s.cell_id
          AND t.side       = 'target'
          AND t.target_lang = ?
        WHERE s.project_id = ?
          AND s.file_id    = ?
          AND s.side       = 'source'
          AND s.target_lang = ''
          AND s.canonical_ref IS NULL
          AND (s.metadata::jsonb)->'aquillaOrigin'->>'kind' = 'user-insert'`,
    )
    .bind(lane, projectId, fileId)
    .all<AddedCellRow>()

  const rows = (added.results ?? []).filter((r) => (r.value ?? '').trim() !== '')
  if (rows.length === 0) return new Map()

  // Resolve each addition's anchor to a verse. One hop is the common case, but
  // two cells added in a row chain through each other, so walk until a row
  // carries a canonical_ref. Batched a round at a time rather than a query per
  // cell — a chapter's worth of additions is one or two rounds.
  const anchorOf = new Map<string, string | null>()
  const refOf = new Map<string, string | null>()

  let frontier = [...new Set(rows.map((r) => r.anchor_cell_id).filter((id): id is string => Boolean(id)))]
  for (let hop = 0; hop < MAX_ANCHOR_HOPS && frontier.length > 0; hop++) {
    const placeholders = frontier.map(() => '?').join(', ')
    const found = await db
      .prepare(
        `SELECT cell_id, anchor_cell_id, canonical_ref
           FROM cells
          WHERE project_id = ? AND file_id = ? AND side = 'source' AND target_lang = ''
            AND cell_id IN (${placeholders})`,
      )
      .bind(projectId, fileId, ...frontier)
      .all<AnchorRow>()

    const next: string[] = []
    for (const row of found.results ?? []) {
      anchorOf.set(row.cell_id, row.anchor_cell_id)
      refOf.set(row.cell_id, row.canonical_ref)
      // Keep walking past a cell that has no address of its own — another
      // addition, most likely — but never revisit one, which is what stops a
      // cycle from spinning here.
      if (!row.canonical_ref && row.anchor_cell_id && !refOf.has(row.anchor_cell_id)) {
        next.push(row.anchor_cell_id)
      }
    }
    frontier = [...new Set(next)]
  }

  /** The verse this cell ultimately follows, and how far away it was. */
  const resolve = (start: string | null): { ref: string; depth: number } | null => {
    let current = start
    for (let depth = 1; current && depth <= MAX_ANCHOR_HOPS; depth++) {
      const ref = refOf.get(current)
      if (ref) return { ref, depth }
      // A row we never found — its cell is gone, most likely removed. Placing
      // the addition anywhere else would put the client's content under the
      // wrong verse, so place nothing.
      if (!anchorOf.has(current)) return null
      current = anchorOf.get(current) ?? null
    }
    return null
  }

  const byRef = new Map<string, Array<{ depth: number; cellId: string; value: string }>>()
  for (const row of rows) {
    const anchor = resolve(row.anchor_cell_id)
    if (!anchor) continue
    const list = byRef.get(anchor.ref) ?? []
    list.push({ depth: anchor.depth, cellId: row.cell_id, value: (row.value ?? '').trim() })
    byRef.set(anchor.ref, list)
  }

  const appendAfter = new Map<string, readonly string[]>()
  for (const [ref, list] of byRef) {
    // Chain order: the cell one hop from the verse comes before the cell that
    // follows it. The cell id breaks a tie deterministically — two additions at
    // the same depth means the chain forked, which the reader should at least
    // see the same way twice.
    list.sort((a, b) => a.depth - b.depth || (a.cellId < b.cellId ? -1 : 1))
    appendAfter.set(ref, list.map((e) => e.value))
  }
  return appendAfter
}

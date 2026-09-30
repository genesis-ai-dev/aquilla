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
//   - REMOVALS: verses somebody deleted, and (AQU-1423) verses somebody HID.
//     Without these every removal is silently undone at export, because a
//     removed cell and an untranslated one look identical from here: both simply
//     have no translation, and the serializer's job is to leave the client's
//     original words alone. A hidden cell is the same story with a row still in
//     the table — see `hidden-cells.ts` for why it joins the removals rather
//     than getting a fourth part of its own.
//
// ORDER OF QUERIES IS LOAD-BEARING FOR THE TESTS. `export-route.test.ts` stubs
// the database and used to route by prepare-call ORDINAL. That stub now routes
// on SQL text, but the translations query still runs first here so the change
// stays reviewable against the old shape.

import { removedCellsForFile } from './removed-cells'
import { hiddenCellsForFile } from './hidden-cells'
import { targetLaneDualReadBinds, targetLaneDualReadSql } from './lane-id-sql'
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

export interface UsfmExportPlanOptions {
  /**
   * AQU-1148: overlay ONLY translations that meet the project's validation
   * threshold. A verse whose target is an unvalidated human draft or an
   * untouched AI draft then contributes nothing, so the serializer leaves the
   * client's own original words in its place — exactly what already happens to
   * an untranslated verse. The SPA asks for this with `?validated=1`.
   *
   * `cells.validated` is the server-owned flag the projection writes; it is
   * the one authoritative definition of validated (AQU-279), and the SPA's
   * `CellData.status` is derived from the same row.
   */
  validatedOnly?: boolean
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
  options: UsfmExportPlanOptions = {},
): Promise<UsfmExportPlan> {
  // AQU-1148: one extra predicate rather than a second query — `cells` is
  // already indexed on (project_id, file_id, side, validated).
  const validatedPredicate = options.validatedOnly ? `\n          AND t.validated <> 0` : ''
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
          AND ${targetLaneDualReadSql('t')}
          AND s.canonical_ref IS NOT NULL
          AND t.value <> ''${validatedPredicate}`,
    )
    .bind(projectId, fileId, ...targetLaneDualReadBinds(projectId, lane))
    .all<{ canonical_ref: string; value: string }>()

  const overrides = new Map<string, string>()
  for (const row of cells.results ?? []) overrides.set(row.canonical_ref, row.value)

  const edits: UsfmEdits = {}

  // AQU-1423: read the parked cells ONCE, before the two steps that both need
  // them. A hidden cell with a verse address joins the removals below; a hidden
  // cell WITHOUT one was added in the app, and is kept out of the additions
  // instead — nothing else would stop its text being written into the verse it
  // follows. Fails soft to an empty list, so an older database (or any error
  // here) leaves the export exactly as it is today.
  const hiddenCells = await hiddenCellsForFile(db, projectId, fileId)

  // 2. Additions. Everything beyond this point is best-effort: a failure must
  //    degrade to today's behaviour (a correct file missing the new content)
  //    rather than lose the whole download.
  try {
    const hiddenIds = new Set(hiddenCells.map((c) => c.cellId))
    const appendAfter = await resolveAdditions(db, projectId, fileId, lane, options, hiddenIds)
    if (appendAfter.size > 0) edits.appendAfter = appendAfter
  } catch {
    // leave additions out
  }

  // 3. Removals. Only a cell that HAD a verse address can be dropped from the
  //    file — one added in the app was never in it, so there is nothing to
  //    remove, which is why the null refs fall away here.
  //
  //    Deleted and hidden cells share this set because they mean the same thing
  //    to the serializer: the span leaves the file, marker included. `remove` is
  //    tested BEFORE the override lookup there, so a hidden verse that carries a
  //    translation is dropped rather than emitted — the one ordering this relies
  //    on, and the reason nothing has to prune `overrides` above.
  const removedRefs = new Set<string>()
  for (const removed of await removedCellsForFile(db, projectId, fileId)) {
    if (removed.canonicalRef) removedRefs.add(removed.canonicalRef)
  }
  for (const hidden of hiddenCells) {
    if (hidden.canonicalRef) removedRefs.add(hidden.canonicalRef)
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
  options: UsfmExportPlanOptions = {},
  /** AQU-1423: cell ids that are hidden. An added cell that is parked
   *  contributes nothing, exactly as one with no translation does — the caller
   *  resolves the set so the hidden read happens once per plan. */
  hiddenIds: ReadonlySet<string> = new Set(),
): Promise<Map<string, readonly string[]>> {
  // AQU-1148: on the LEFT JOIN, so a non-validated addition comes back with a
  // null value and falls out of the `.trim() !== ''` filter below — the same
  // path an addition with no translation at all already takes.
  const validatedPredicate = options.validatedOnly ? `\n          AND t.validated <> 0` : ''
  const added = await db
    .prepare(
      `SELECT s.cell_id AS cell_id, s.anchor_cell_id AS anchor_cell_id, t.value AS value
         FROM cells s
         LEFT JOIN cells t
           ON t.project_id = s.project_id
          AND t.file_id    = s.file_id
          AND t.cell_id    = s.cell_id
          AND t.side       = 'target'
          AND ${targetLaneDualReadSql('t')}${validatedPredicate}
        WHERE s.project_id = ?
          AND s.file_id    = ?
          AND s.side       = 'source'
          AND s.target_lang = ''
          AND s.canonical_ref IS NULL
          AND (s.metadata::jsonb)->'aquillaOrigin'->>'kind' = 'user-insert'`,
    )
    .bind(...targetLaneDualReadBinds(projectId, lane), projectId, fileId)
    .all<AddedCellRow>()

  const rows = (added.results ?? []).filter(
    (r) => (r.value ?? '').trim() !== '' && !hiddenIds.has(r.cell_id),
  )
  return placeAdditions(db, projectId, fileId, rows)
}

/**
 * Group added cells under the verse each one ultimately follows.
 *
 * Shared by the target-side and source-side plans: which VALUE an addition
 * carries differs between them (a translation vs. the curated source text), but
 * where it lands does not — the anchor chain is source-side structure and has
 * one answer per file.
 */
async function placeAdditions(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  rows: readonly AddedCellRow[],
): Promise<Map<string, readonly string[]>> {
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

// ---------------------------------------------------------------------------
// AQU-1449: the SOURCE side of the same three questions.
// ---------------------------------------------------------------------------

/**
 * What a source-side USFM export needs to know about one file.
 *
 * Same shape as the target plan and fed to the same serializer, but every part
 * is answered from the source side:
 *
 *   - OVERRIDES are verses whose source text was EDITED in the app, and only
 *     those. A verse nobody touched contributes no override, which is what
 *     keeps its original span byte-identical — footnotes, character markers and
 *     poetry included. Overlaying every verse with its projected `value` would
 *     rewrite the whole file as plain text and strip all of that, so "was this
 *     edited?" has to be answered exactly rather than guessed at.
 *
 *     The answer is the cell's CHAIN HEAD: the projection writes the winning
 *     event's id to `cells.event_id`, so a head of kind `source.cell.commit`
 *     means the live text came from an edit (the editor's "Edit text", or a DCS
 *     re-pin to a newer upstream release), and a head of `source.cell.create`
 *     means it came from the import untouched. Reading the head rather than
 *     merely asking whether a commit event EXISTS matters: a commit that lost
 *     its AD-2 head compare-and-swap applied nothing, and treating that as an
 *     edit would strip the markers off a verse nobody changed.
 *
 *   - REMOVALS are exactly the target plan's: deleted and hidden verses leave
 *     the file, marker included.
 *
 *   - ADDITIONS are cells added in the app that carry SOURCE text, placed under
 *     the verse they follow by the same anchor chain.
 *
 * No lane and no validation threshold: the source side has neither, so the
 * output is the same whichever lane the exporting client happens to be on.
 */
export async function buildUsfmSourceExportPlan(
  db: AquillaDb,
  projectId: string,
  fileId: string,
): Promise<UsfmExportPlan> {
  // A hidden verse is REMOVED below, so it must not also arrive as an override:
  // an override is the serializer's "write this text here" and would put the
  // parked verse back. The removal is tested first there, but leaving the two
  // consistent costs nothing and keeps the plan honest on its own.
  const edited = await db
    .prepare(
      `SELECT c.canonical_ref AS canonical_ref, c.value AS value
         FROM cells c
         JOIN events e ON e.id = c.event_id
        WHERE c.project_id = ?
          AND c.file_id    = ?
          AND c.side       = 'source'
          AND c.target_lang = ''
          AND c.canonical_ref IS NOT NULL
          AND c.hidden_at IS NULL
          AND c.value <> ''
          AND e.kind = 'source.cell.commit'`,
    )
    .bind(projectId, fileId)
    .all<{ canonical_ref: string; value: string }>()

  const overrides = new Map<string, string>()
  for (const row of edited.results ?? []) overrides.set(row.canonical_ref, row.value)

  const edits: UsfmEdits = {}

  const hiddenCells = await hiddenCellsForFile(db, projectId, fileId)

  // Best-effort, exactly as on the target side: a failure here degrades to a
  // correct file missing the added content rather than losing the download.
  try {
    const hiddenIds = new Set(hiddenCells.map((c) => c.cellId))
    const appendAfter = await resolveSourceAdditions(db, projectId, fileId, hiddenIds)
    if (appendAfter.size > 0) edits.appendAfter = appendAfter
  } catch {
    // leave additions out
  }

  const removedRefs = new Set<string>()
  for (const removed of await removedCellsForFile(db, projectId, fileId)) {
    if (removed.canonicalRef) removedRefs.add(removed.canonicalRef)
  }
  for (const hidden of hiddenCells) {
    if (hidden.canonicalRef) removedRefs.add(hidden.canonicalRef)
  }
  if (removedRefs.size > 0) edits.remove = removedRefs

  return { overrides, edits }
}

/**
 * Added cells that carry source text, grouped under the verse each follows.
 *
 * The source-side twin of `resolveAdditions`: one query rather than a join,
 * because the value wanted is the added cell's OWN text. An added cell with no
 * source text contributes nothing, and a hidden one contributes nothing either —
 * the same two exclusions the target side applies.
 */
async function resolveSourceAdditions(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  hiddenIds: ReadonlySet<string> = new Set(),
): Promise<Map<string, readonly string[]>> {
  const added = await db
    .prepare(
      `SELECT cell_id, anchor_cell_id, value
         FROM cells
        WHERE project_id = ?
          AND file_id    = ?
          AND side       = 'source'
          AND target_lang = ''
          AND canonical_ref IS NULL
          AND (metadata::jsonb)->'aquillaOrigin'->>'kind' = 'user-insert'`,
    )
    .bind(projectId, fileId)
    .all<AddedCellRow>()

  const rows = (added.results ?? []).filter(
    (r) => (r.value ?? '').trim() !== '' && !hiddenIds.has(r.cell_id),
  )
  return placeAdditions(db, projectId, fileId, rows)
}

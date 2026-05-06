// Y.Doc hydration from D1 events for CQRS Phase 4d.
//
// When a `FileSync` Durable Object boots and finds no R2 snapshot, it can
// reconstruct the Y.Doc by replaying every cell.commit event for this
// (project, file) in server_ts order. This is what lets idempotent
// gitlab-style imports flow as `POST /events` only — clients open the
// project, the DO hits this code path, the imported cells appear without
// any prior R2 round-trip.
//
// Validation events (cell.validate / cell.unvalidate) are intentionally
// skipped: validators live in `cell_validators` (D1) and are read by
// `useCellsAuditStatsWithOverlay`, not from the Y.Doc. Phase 4a moved the
// reads off Y.Doc walks; replaying validations into the doc would be a
// no-op for the UI and just bloat the snapshot.

import * as Y from 'yjs'
import type { CellSeedMeta, EventKind } from './types'
import { htmlToFragment, plainTextToFragment } from './html-to-fragment'

export interface CellCommitPayload {
  value: string
  valueHtml?: string
  prevEventId?: string
  meta?: CellSeedMeta
}

/** Subset of the events row we read for hydration. */
interface EventRow {
  id: string
  schema_version: number
  project_id: string
  file_id: string | null
  cell_id: string | null
  kind: string
  author: string
  payload: string // JSON
  client_ts: number
  server_ts: number
}

export interface HydrateResult {
  /** Cell count after hydration; 0 means no events found. */
  cellCount: number
  /** Total events read (includes events skipped during hydration). */
  eventsRead: number
  /** cell.commit events actually projected into the doc. */
  cellCommitsApplied: number
}

/**
 * Replay D1 events for a single (projectId, fileId) into an existing Y.Doc.
 * Mutates `doc` in a single transaction so observers fire once. Cells are
 * appended to the `order` Y.Array in event-arrival order (oldest server_ts
 * first); the same cell receiving multiple commits collapses to a single
 * entry in `order`, with `translatedXml` reflecting the most recent value.
 *
 * Returns counters for diagnostics. Caller decides whether to persist the
 * mutated doc back to R2 (FileSync.onLoad does this so subsequent loads
 * are fast).
 */
export async function hydrateYDocFromEvents(
  db: D1Database,
  projectId: string,
  fileId: string,
  doc: Y.Doc,
): Promise<HydrateResult> {
  const { results } = await db
    .prepare(
      `SELECT id, schema_version, project_id, file_id, cell_id, kind,
              author, payload, client_ts, server_ts
       FROM events
       WHERE project_id = ? AND file_id = ?
       ORDER BY server_ts ASC`,
    )
    .bind(projectId, fileId)
    .all<EventRow>()

  const rows = results ?? []
  if (rows.length === 0) {
    return { cellCount: 0, eventsRead: 0, cellCommitsApplied: 0 }
  }

  const cellsMap = doc.getMap('cells')
  const orderArr = doc.getArray<string>('order')
  // Track which cell IDs we've already pushed into `order` so we don't
  // duplicate entries when a cell receives multiple commits during replay.
  const orderedSeen = new Set<string>(orderArr.toArray())
  // Cells that already exist in the doc (from R2 snapshot) should not be
  // re-seeded with metadata; the replay is purely for cells D1 has but the
  // doc doesn't. The hydration callsite gates on `cellsMap.size === 0` so
  // this set is empty in practice, but the bookkeeping costs nothing.
  const existingCellIds = new Set<string>(cellsMap.keys())

  let cellCommitsApplied = 0

  doc.transact(() => {
    for (const row of rows) {
      if (row.kind !== ('cell.commit' satisfies EventKind)) continue
      if (!row.cell_id) continue

      let payload: CellCommitPayload
      try {
        payload = JSON.parse(row.payload) as CellCommitPayload
      } catch {
        // Skip malformed events rather than aborting the whole hydration.
        continue
      }

      const cellId = row.cell_id
      const isFirstSeed = !cellsMap.has(cellId) && !existingCellIds.has(cellId)
      // Internal apply: caller already wraps the whole replay in a transaction,
      // so we use `applyCellCommit` (not `applyCellCommitToDoc`) which expects
      // to run inside an existing one.
      applyCellCommitInTransaction(cellsMap, orderArr, orderedSeen, cellId, payload, isFirstSeed)
      cellCommitsApplied += 1
    }
  })

  return {
    cellCount: cellsMap.size,
    eventsRead: rows.length,
    cellCommitsApplied,
  }
}

/**
 * Apply a single `cell.commit` payload to a Y.Doc in its own transaction.
 *
 * Used by the hot-update path (events route → DO) so a freshly-imported
 * cell appears in any open editor without requiring a reload. Returns
 * `true` when the cell was new (added to `order` + cells map), `false`
 * when the cell already existed and the commit was treated as an
 * update — see the `mode` parameter for control over the latter.
 */
export interface ApplyCellCommitInput {
  cellId: string
  payload: CellCommitPayload
  /**
   * - `'new-only'` (default): no-op when the cell already exists. Safe for
   *   hot-applying imports without clobbering active edits.
   * - `'overwrite'`: always update translatedXml + (re-)apply seed meta on
   *   first occurrence. Used by hydration internally.
   */
  mode?: 'new-only' | 'overwrite'
}

export function applyCellCommitToDoc(
  doc: Y.Doc,
  input: ApplyCellCommitInput,
): { applied: boolean; created: boolean } {
  const cellsMap = doc.getMap('cells')
  const orderArr = doc.getArray<string>('order')
  const orderedSeen = new Set<string>(orderArr.toArray())
  const mode = input.mode ?? 'new-only'

  const exists = cellsMap.has(input.cellId)
  if (mode === 'new-only' && exists) {
    return { applied: false, created: false }
  }

  let result = { applied: false, created: false }
  doc.transact(() => {
    const isFirstSeed = !exists
    applyCellCommitInTransaction(
      cellsMap,
      orderArr,
      orderedSeen,
      input.cellId,
      input.payload,
      isFirstSeed,
    )
    result = { applied: true, created: !exists }
  })
  return result
}

function applyCellCommitInTransaction(
  cellsMap: Y.Map<unknown>,
  orderArr: Y.Array<string>,
  orderedSeen: Set<string>,
  cellId: string,
  payload: CellCommitPayload,
  isFirstSeed: boolean,
): void {
  let cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) {
    cell = new Y.Map<unknown>()
    cellsMap.set(cellId, cell)
  }
  cell.set('id', cellId)

  // Seed metadata only on first occurrence — protects against a misbehaving
  // client that sends `meta` on a later commit, and against an accidental
  // re-import overwriting fields the user has already adjusted.
  if (isFirstSeed && payload.meta) {
    const m = payload.meta
    if (typeof m.original === 'string') cell.set('original', m.original)
    if (typeof m.originalHtml === 'string') cell.set('originalHtml', m.originalHtml)
    if (typeof m.context === 'string') cell.set('context', m.context)
    if (typeof m.group === 'string') cell.set('group', m.group)
    if (typeof m.type === 'string') cell.set('type', m.type)
    if (m.sourceLocation && typeof m.sourceLocation === 'object') {
      cell.set('sourceLocation', m.sourceLocation)
    }
    if (Array.isArray(m.globalReferences)) {
      cell.set('globalReferences', m.globalReferences)
    }
    if (typeof m.cellLabel === 'string') {
      cell.set('__source', { metadata: { id: cellId, cellLabel: m.cellLabel } })
    }
  }

  // Prefer valueHtml so inline marks survive; fall back to plain text.
  // Fragment is rebuilt outright — committed snapshots, not CRDT deltas.
  const frag =
    typeof payload.valueHtml === 'string' && payload.valueHtml.length > 0
      ? htmlToFragment(payload.valueHtml)
      : plainTextToFragment(payload.value ?? '')
  cell.set('translatedXml', frag)

  if (!orderedSeen.has(cellId)) {
    orderArr.push([cellId])
    orderedSeen.add(cellId)
  }
}

// Y.Doc hydration from D1 events.
//
// When a `FileSync` Durable Object boots and finds no R2 snapshot, it can
// reconstruct the doc by replaying every cell event for this
// `(project, file)` in `server_seq` order. Phase 2 will likely remove the
// Y.Doc entirely (AD-1's live-doc state can be modeled directly off the
// event stream), but for now this path keeps the partyserver-based focus-
// lock surface alive against the new event kinds.
//
// Cell events that contribute to the doc:
//   - source.cell.create / target.cell.create — seed the cell row + value.
//   - source.cell.commit / target.cell.commit — update the value.
//   - source.cell.delete / target.cell.delete — drop from the doc.
//   - source.cell.reorder / target.cell.reorder — re-anchor in `order`.
// cell.validate / cell.unvalidate are intentionally skipped (validators
// live in cell_validators, not the doc).

import * as Y from 'yjs'
import type { EventKind, EventPayloads } from './types'
import { htmlToFragment, plainTextToFragment } from './html-to-fragment'

/** Subset of the events row we read for hydration. */
interface EventRow {
  id: string
  schema_version: number
  project_id: string
  file_id: string | null
  cell_id: string | null
  kind: string
  parent_id: string | null
  author: string
  payload: string // JSON
  client_ts: number
  server_ts: number
  server_seq: number
}

export interface HydrateResult {
  /** Cell count after hydration. */
  cellCount: number
  /** Total events read. */
  eventsRead: number
  /** Cell-mutating events actually projected into the doc. */
  cellEventsApplied: number
}

/**
 * Replay D1 events for a single (projectId, fileId) into an existing Y.Doc.
 * Mutates `doc` in a single transaction so observers fire once. Cells are
 * appended to the `order` Y.Array in event-arrival order (oldest server_seq
 * first). Returns counters for diagnostics.
 */
export async function hydrateYDocFromEvents(
  db: D1Database,
  projectId: string,
  fileId: string,
  doc: Y.Doc,
): Promise<HydrateResult> {
  const { results } = await db
    .prepare(
      `SELECT id, schema_version, project_id, file_id, cell_id, kind, parent_id,
              author, payload, client_ts, server_ts, server_seq
       FROM events
       WHERE project_id = ? AND file_id = ?
       ORDER BY server_seq ASC, server_ts ASC, id ASC`,
    )
    .bind(projectId, fileId)
    .all<EventRow>()

  const rows = results ?? []
  if (rows.length === 0) {
    return { cellCount: 0, eventsRead: 0, cellEventsApplied: 0 }
  }

  const cellsMap = doc.getMap('cells')
  const orderArr = doc.getArray<string>('order')
  const orderedSeen = new Set<string>(orderArr.toArray())

  let cellEventsApplied = 0

  doc.transact(() => {
    for (const row of rows) {
      if (!row.cell_id) continue
      const kind = row.kind as EventKind
      const cellId = row.cell_id

      let payload: unknown
      try {
        payload = JSON.parse(row.payload)
      } catch {
        continue
      }

      switch (kind) {
        case 'source.cell.create':
        case 'target.cell.create': {
          const p = payload as EventPayloads['source.cell.create']
          applyCreate(cellsMap, orderArr, orderedSeen, cellId, p)
          cellEventsApplied += 1
          break
        }
        case 'source.cell.commit':
        case 'target.cell.commit': {
          const p = payload as EventPayloads['target.cell.commit']
          applyCommit(cellsMap, orderArr, orderedSeen, cellId, p)
          cellEventsApplied += 1
          break
        }
        case 'source.cell.delete':
        case 'target.cell.delete': {
          applyDelete(cellsMap, orderArr, orderedSeen, cellId)
          cellEventsApplied += 1
          break
        }
        case 'source.cell.reorder':
        case 'target.cell.reorder': {
          // The Y.Array `order` here doesn't carry anchor semantics — we
          // leave order alone and let downstream rebuilders interpret
          // anchor_cell_id from the cell's own field if present.
          const p = payload as EventPayloads['target.cell.reorder']
          const cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
          if (cell) cell.set('anchorCellId', p.anchorCellId ?? null)
          cellEventsApplied += 1
          break
        }
        case 'cell.validate':
        case 'cell.unvalidate':
        case 'file.create':
          // Not part of the doc projection.
          break
      }
    }
  })

  return {
    cellCount: cellsMap.size,
    eventsRead: rows.length,
    cellEventsApplied,
  }
}

function applyCreate(
  cellsMap: Y.Map<unknown>,
  orderArr: Y.Array<string>,
  orderedSeen: Set<string>,
  cellId: string,
  payload: EventPayloads['source.cell.create'] | EventPayloads['target.cell.create'],
): void {
  let cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) {
    cell = new Y.Map<unknown>()
    cellsMap.set(cellId, cell)
  }
  cell.set('id', cellId)
  if (typeof payload.type === 'string') cell.set('type', payload.type)
  if (typeof payload.anchorCellId === 'string' || payload.anchorCellId === null) {
    cell.set('anchorCellId', payload.anchorCellId)
  }

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

function applyCommit(
  cellsMap: Y.Map<unknown>,
  orderArr: Y.Array<string>,
  orderedSeen: Set<string>,
  cellId: string,
  payload: EventPayloads['source.cell.commit'] | EventPayloads['target.cell.commit'],
): void {
  let cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) {
    cell = new Y.Map<unknown>()
    cellsMap.set(cellId, cell)
    cell.set('id', cellId)
  }
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

function applyDelete(
  cellsMap: Y.Map<unknown>,
  orderArr: Y.Array<string>,
  orderedSeen: Set<string>,
  cellId: string,
): void {
  cellsMap.delete(cellId)
  if (orderedSeen.has(cellId)) {
    for (let i = 0; i < orderArr.length; i++) {
      if (orderArr.get(i) === cellId) {
        orderArr.delete(i, 1)
        break
      }
    }
    orderedSeen.delete(cellId)
  }
}

// ── Hot-apply path (legacy compatibility) ──────────────────────────────
//
// Originally used after a successful POST /events to push imported cell
// values into any currently-open live editor. Now retained as a no-op
// shim so the worker fetch handler can be updated incrementally; the
// route layer no longer calls it because the live-doc state will be
// rebuilt in Phase 2.

export interface ApplyCellCommitInput {
  cellId: string
  payload: { value: string; valueHtml?: string }
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
    applyCommit(cellsMap, orderArr, orderedSeen, input.cellId, input.payload)
    result = { applied: true, created: !exists }
  })
  return result
}

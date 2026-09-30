// Phase 4: query helpers over the local LiveStore offline store, consumed by
// both the read-path branch (useCells.ts) and the write-path routing
// (outbox.ts) to decide whether a given project should be served from local
// SQLite instead of sync-worker HTTP.
import type { Store } from "@livestore/livestore"
import { tables, type schema } from "./schema"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { isTauriRuntime } from "./is-tauri"

/**
 * True iff `projectId` has a fully downloaded, ready-to-use offline copy in
 * this LiveStore store. `downloading`/`removing` rows are deliberately NOT
 * ready — a project mid-download has an incomplete cell set, and one mid-removal
 * is about to lose its rows out from under a reader.
 */
export function isProjectOfflineReady(store: Store<typeof schema>, projectId: string): boolean {
  const row = store.query(tables.offlineProjects.select().where({ projectId, status: "ready" }).first())
  return row != null
}

/**
 * True iff `projectId` should be read from the local LiveStore offline store
 * instead of sync-worker HTTP: we're in the Tauri desktop shell, the store
 * has finished booting, and this project has a complete, ready-to-use local
 * copy. Outside Tauri (the plain browser SPA), `isTauriRuntime()` is false
 * and this is always null — every existing web code path is unaffected.
 *
 * Shared by every cell-read hook (`useCells.ts`, `useActiveCellStore.ts`) so
 * the offline-eligibility rule can't drift between them.
 */
export function resolveOfflineStore(
  store: Store<typeof schema> | null,
  projectId: string | null,
): Store<typeof schema> | null {
  if (!store || !projectId || !isTauriRuntime()) return null
  return isProjectOfflineReady(store, projectId) ? store : null
}

export interface ReadOfflineFileCellsOptions {
  /** Restrict to a single side, matching `FetchFileCellsOptions.side` in
   *  cells-read.ts. Omit for both sides, combined. */
  side?: "source" | "target"
}

/**
 * The subset of the local `cells` table's columns (see schema.ts) needed to
 * build a `CellRow`. Declared structurally rather than derived from
 * `tables.cells`'s query-result type so this stays simple regardless of
 * LiveStore's internal row-type plumbing — the real query result always has
 * (at least) these fields.
 */
interface OfflineCellsRow {
  cellId: string
  side: "source" | "target"
  value: string | null
  valueHtml: string | null
  eventId: string | null
  sourceEventId: string | null
  validated: boolean
  aiDrafted: boolean
  sequenceIndex: number
  canonicalRef: string | null
}

function toCellRow(row: OfflineCellsRow): CellRow {
  return {
    cellId: row.cellId,
    side: row.side,
    // The server's `value`/`eventId` are non-nullable on `CellRow`; the local
    // column allows null (a cell synced before it ever got a value/event).
    // `""` is the same "nothing yet" sentinel useCells.ts's own synthetic
    // rows use (see applyOptimisticTargetEdit).
    value: row.value ?? "",
    valueHtml: row.valueHtml,
    eventId: row.eventId ?? "",
    sourceEventId: row.sourceEventId,
    validated: row.validated,
    aiDrafted: row.aiDrafted,
    sequenceIndex: row.sequenceIndex,
    canonicalRef: row.canonicalRef,
    // Not tracked by the offline schema — buildCellData() in useCells.ts
    // already tolerates these being absent/default the same way it handles
    // legacy pre-migration server rows. `type`/`anchorCellId`/`lastEditor`
    // are nullable on CellRow so `null` is the honest value; `lastEditAt`/
    // `wordCount` are non-nullable numbers with no local equivalent, so `0`
    // is used as an inert filler — every consumer that reads them already
    // treats a falsy/absent value the same way (see useLivingMemory.ts,
    // ProjectWorkspace.tsx's cache-key fallback).
    type: null,
    anchorCellId: null,
    lastEditor: null,
    lastEditAt: 0,
    wordCount: 0,
  }
}

/**
 * Reads every locally-synced cell row for one file out of the offline
 * LiveStore `cells` table and maps it into the same `CellRow` shape
 * `cells-read.ts` returns from sync-worker HTTP, so `useCells.ts`'s
 * `buildCellData()` can consume either without knowing which store it came
 * from.
 *
 * Ordering matches `streamFileCells`'s documented contract: with no `side`
 * filter, every source row (by `sequenceIndex`) comes before every target
 * row (by `sequenceIndex`); with a `side` filter, rows come back sorted by
 * `sequenceIndex` within that side. There is no anchor-chain concept locally
 * — `sequenceIndex` is the intrinsic order key LiveStore rows carry instead.
 */
export function readOfflineFileCells(
  store: Store<typeof schema>,
  projectId: string,
  fileId: string,
  opts: ReadOfflineFileCellsOptions = {},
): CellRow[] {
  const where = opts.side ? { projectId, fileId, side: opts.side } : { projectId, fileId }
  const rows = store.query(tables.cells.select().where(where))
  const sorted = [...rows].sort((a, b) => {
    if (a.side !== b.side) return a.side === "source" ? -1 : 1
    return a.sequenceIndex - b.sequenceIndex
  })
  return sorted.map(toCellRow)
}

/**
 * Subscribes to changes affecting this file's row set within the local
 * `cells` table — e.g. the Phase 3 sync adapter applying an incoming remote
 * commit, or this device's own queued write materializing once it flushes.
 * Neither happens as a result of anything `useCells.ts` itself calls, so a
 * caller that wants offline reads to stay live (rather than only refreshing
 * on the next window-focus revalidate or explicit `revalidate()`) should
 * re-read via `readOfflineFileCells` whenever this fires.
 *
 * `onChange` may also fire on a write to the `cells` table that turns out
 * not to touch this (projectId, fileId) — LiveStore's reactive invalidation
 * isn't scoped tighter than the table, only the query result is. Callers
 * must treat this as "maybe changed, go re-read" rather than "definitely
 * changed"; re-reading is cheap (a local SQLite query) so this is fine.
 * Returns an unsubscribe function.
 */
export function subscribeToOfflineFileCells(
  store: Store<typeof schema>,
  projectId: string,
  fileId: string,
  onChange: () => void,
): () => void {
  return store.subscribe(tables.cells.select().where({ projectId, fileId }), onChange)
}

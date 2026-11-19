// Phase 2b: aligned with the Phase 2a fetch pattern (vanilla useState +
// race-guarded effect; no React Query). Same upstream endpoint
// (`/cells/audit-stats?fileId=`) — the migration is purely about pattern
// consistency.
//
// `useCompositeHealth` consumes this hook's Map as a useEffect dep, so we
// preserve a stable empty-map reference between renders to avoid resetting
// its debounce on every keystroke.

import { useCallback, useEffect, useRef, useState } from "react"
import type { RuleWaiver } from "@/lib/parsers/types"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import { subscribeWindowRegainedFocus } from "@/lib/sync/window-focus-revalidate"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { contentHash } from "@/lib/dcs/content-hash"
import { applyOutboxOverlay } from "@/lib/sync/audit-stats-overlay"
import type { OutboxRecord } from "@/lib/sync/outbox"

export interface CellAuditStats {
  cellId: string
  editCount: number
  contentHash: string
  /** Server clock at the cell's most recent commit. null when the cell hasn't been
   *  projected from a CQRS event yet (e.g. legacy Y.Doc-only seeded rows). */
  lastEditAt: number | null
  /** UUIDv7 of the cell.commit event that produced the current value. Carry this
   *  on validate/unvalidate events so the validator binds to the right edit. */
  lastEditEventId: string | null
  /** Active validators tied to lastEditEventId. Empty when the current edit has
   *  no approvals or when lastEditEventId is null. */
  activeValidators: string[]
  /** AQU-2296: username → when that validator cast the vote tied to
   *  `lastEditEventId` (server clock, ms). Keyed by name rather than paired
   *  positionally with `activeValidators`, so the two cannot drift. A name
   *  with no entry has no known stamp. Optional for the same reason the wire
   *  field is: a fixture or a worker that predates it reads as "no stamps
   *  known", which the popover draws as a name with no date line. */
  validatorDecidedTs?: Record<string, number>
  /** Active QA rule waivers on this cell (one per dismissed rule). Empty when
   *  no rule is currently waived. */
  waivers: RuleWaiver[]
}

interface UseCellsAuditStatsOptions {
  enabled: boolean
  fileId: string | null
  getTokenForFile: (fileId: string) => Promise<string | null>
  /** AQU-538 active target lane ('' = default). Picks which target row's
   *  head a derived stats entry follows when a cell has several lanes. */
  lane?: string
}

/** The projected row a committed cell's stats entry follows on `lane` (the
 *  reading deriveCommittedCellStats documents); undefined when `rows` has no
 *  row for the cell at all. */
function committedStatsRow(cellId: string, rows: readonly CellRow[], lane: string): CellRow | undefined {
  const targets = rows.filter((r) => r.cellId === cellId && r.side === "target")
  return (
    targets.find((r) => (r.targetLang ?? "") === lane) ??
    targets[0] ??
    rows.find((r) => r.cellId === cellId && r.side === "source")
  )
}

/**
 * The audit-stats entry the server would return for a cell whose projected
 * rows are `rows` — the same reading `/cells/audit-stats` does: the target
 * row wins over source, `lastEditEventId` is the row's chain head, and
 * validators are keyed on that head (a fresh head has none). `contentHash`
 * uses the verbatim port of the server's djb2. Waivers and `editCount` are
 * not on the row and carry over from `prev`.
 */
export function deriveCommittedCellStats(
  cellId: string,
  rows: readonly CellRow[],
  lane: string,
  prev: CellAuditStats | undefined,
): CellAuditStats | null {
  const row = committedStatsRow(cellId, rows, lane)
  if (!row) return null
  const headChanged = prev?.lastEditEventId !== row.eventId
  return {
    cellId,
    editCount: prev?.editCount ?? 0,
    contentHash: contentHash(row.value),
    lastEditAt: row.lastEditAt ?? null,
    lastEditEventId: row.eventId,
    activeValidators: headChanged ? [] : (prev?.activeValidators ?? []),
    validatorDecidedTs: headChanged ? {} : (prev?.validatorDecidedTs ?? {}),
    waivers: prev?.waivers ?? [],
  }
}

export interface UseCellsAuditStatsResult {
  byCellId: Map<string, CellAuditStats>
  /** AQU-2094: `byCellId` came from a sparse read, so a cell missing from it
   *  has no validators and no waivers (rather than "not loaded"). */
  complete: boolean
  isLoading: boolean
  isError: boolean
  revalidate: () => void
  /** Targeted refetch for a single cell (e.g. right after that cell's
   *  commit/validate/waive), merged into the existing map. Avoids
   *  re-fetching the whole file's stats on every single-cell commit. */
  revalidateCellStats: (cellId: string) => void
  /** Merge the stats entry implied by a cell's freshly-projected rows (from
   *  the `POST /events` response) instead of a targeted GET. Returns false
   *  when nothing was merged (hook disabled, no target row, other file). */
  applyCommittedCellStats: (cellId: string, rows: readonly CellRow[]) => boolean
  /** AQU-2654: merge the entry an APPLIED validate/unvalidate of the viewer's
   *  own implies, instead of a targeted GET. `record` is the queued event the
   *  server just applied. Returns false when the entry cannot be derived
   *  faithfully (see the implementation) so the caller keeps its read. */
  applyValidationCellStats: (record: Pick<OutboxRecord, "event">) => boolean
}

const EMPTY_AUDIT_STATS = new Map<string, CellAuditStats>()

type CellAuditStatsWireRow = Partial<CellAuditStats> & {
  side?: string
  /** AQU-1506: the row's lane ('' = default). Absent on a pre-lane worker. */
  targetLang?: string
}

function toCellAuditStats(row: CellAuditStatsWireRow): CellAuditStats | null {
  if (!row.cellId) return null
  return {
    cellId: row.cellId,
    editCount: row.editCount ?? 0,
    contentHash: row.contentHash ?? "",
    lastEditAt: row.lastEditAt ?? null,
    lastEditEventId: row.lastEditEventId ?? null,
    activeValidators: row.activeValidators ?? [],
    validatorDecidedTs: row.validatorDecidedTs ?? {},
    waivers: row.waivers ?? [],
  }
}

/** Never picked. */
const RANK_OTHER_LANE = 0
/** Picked only when the active lane has no target row for this cell. */
const RANK_SOURCE = 1
/** The row that answers "who validated this cell, here". */
const RANK_ACTIVE_LANE = 2

/**
 * How much a row deserves to be this cell's stats entry, on `lane`.
 *
 * AQU-1506: a cell on an N-lane file has one target row per lane, and the
 * validators on each are that lane's own. Ranking makes the pick independent
 * of row order — the response arrives in Postgres heap order, which a validate
 * or commit rewrites, so "first target row wins" silently changed answer as
 * people worked.
 *
 * A cell untranslated in this lane has no target row here and falls back to the
 * source row, exactly as an untranslated cell on a single-lane file always has:
 * no validators, and the source head for the staleness pin. Another lane's
 * target row is never a substitute — inheriting its validators is the bug.
 */
function rankStatsRow(row: CellAuditStatsWireRow, lane: string, laneAware: boolean): number {
  if (row.side !== "target") return RANK_SOURCE
  // A pre-lane worker sends no `targetLang` on any row. It cannot tell one
  // lane's row from another's, so keep the historical first-target-row reading
  // rather than reporting every cell on a non-default lane as unvalidated.
  if (!laneAware) return RANK_ACTIVE_LANE
  return (row.targetLang ?? "") === lane ? RANK_ACTIVE_LANE : RANK_OTHER_LANE
}

function mergeStatsRows(
  rows: CellAuditStatsWireRow[],
  lane: string,
): Map<string, CellAuditStats> {
  const laneAware = rows.some((r) => r.targetLang !== undefined)
  const map = new Map<string, CellAuditStats>()
  const ranks = new Map<string, number>()
  for (const row of rows) {
    const rank = rankStatsRow(row, lane, laneAware)
    if (rank === RANK_OTHER_LANE) continue
    const stats = toCellAuditStats(row)
    if (!stats) continue
    // Strictly greater, so the first row of a rank wins — byte-identical to the
    // old first-target-row-wins reading on a single-lane file.
    if (rank > (ranks.get(stats.cellId) ?? -1)) {
      map.set(stats.cellId, stats)
      ranks.set(stats.cellId, rank)
    }
  }
  return map
}

/**
 * AQU-2094: asks for a sparse read — only cells someone has validated or
 * waived. The rest of an entry is on the rows the editor already has, and on a
 * whole Bible the full answer was ~9 MB. A worker that predates the flag
 * answers in full, without `sparse: true`, and `complete` stays false.
 */
async function fetchCellsAuditStats(
  fileId: string,
  jwt: string,
  lane: string,
): Promise<{ map: Map<string, CellAuditStats>; complete: boolean }> {
  const url = `${syncWorkerHttpOrigin()}/cells/audit-stats?fileId=${encodeURIComponent(fileId)}&sparse=1`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`cells/audit-stats failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  const body = (await res.json()) as { cells: CellAuditStatsWireRow[]; sparse?: boolean }
  return { map: mergeStatsRows(body.cells, lane), complete: body.sparse === true }
}

// Single-cell variant of fetchCellsAuditStats — same endpoint, scoped via
// the optional `cellId` query param (see cells-audit-read-route.ts).
async function fetchCellAuditStats(
  fileId: string,
  cellId: string,
  jwt: string,
  lane: string,
): Promise<CellAuditStats | null> {
  const url = `${syncWorkerHttpOrigin()}/cells/audit-stats?fileId=${encodeURIComponent(fileId)}&cellId=${encodeURIComponent(cellId)}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`cells/audit-stats (cell) failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  const body = (await res.json()) as { cells: CellAuditStatsWireRow[] }
  return mergeStatsRows(body.cells, lane).get(cellId) ?? null
}

export function useCellsAuditStats(opts: UseCellsAuditStatsOptions): UseCellsAuditStatsResult {
  const { enabled, fileId, getTokenForFile, lane = "" } = opts

  const [data, setData] = useState<Map<string, CellAuditStats>>(EMPTY_AUDIT_STATS)
  const [complete, setComplete] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)

  const fileRef = useRef(fileId)
  const tokenRef = useRef(getTokenForFile)
  const enabledRef = useRef(enabled)
  const laneRef = useRef(lane)
  const generationRef = useRef(0)
  // AQU-2654: the chain head each cell's entry follows, known synchronously.
  // `data` only catches up on the next render, and a validation is applied on
  // the heels of the commit it validates — before that render. Holds the head
  // of every entry merged since the last full read; a cell not in it reads
  // its head from the rendered map.
  const dataRef = useRef(data)
  const mergedHeadsRef = useRef(new Map<string, string | null>())

  fileRef.current = fileId
  dataRef.current = data
  tokenRef.current = getTokenForFile
  enabledRef.current = enabled
  laneRef.current = lane

  const doFetch = useCallback(async () => {
    const fid = fileRef.current
    if (!enabledRef.current || !fid) {
      setData(EMPTY_AUDIT_STATS)
      setComplete(false)
      setIsLoading(false)
      setIsError(false)
      return
    }
    const gen = ++generationRef.current
    const activeLane = laneRef.current
    setIsLoading(true)
    setIsError(false)
    try {
      const token = await tokenRef.current(fid)
      if (!token) {
        if (generationRef.current !== gen) return
        setIsError(true)
        setIsLoading(false)
        return
      }
      const { map, complete: sparse } = await fetchCellsAuditStats(fid, token, activeLane)
      if (generationRef.current !== gen) return
      mergedHeadsRef.current.clear()
      setData(map)
      setComplete(sparse)
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[useCellsAuditStats] fetch failed:", err)
      setIsError(true)
      setIsLoading(false)
    }
  }, [])

  // AQU-1506: `lane` reloads too. Which row of a cell answers "who validated
  // this" is a per-lane question resolved at merge time, so the map a previous
  // lane produced does not describe this one. Mirrors useCells, which likewise
  // re-fetches and re-derives its view on a lane switch.
  useEffect(() => {
    // Cell ids repeat across files; a head merged for the previous view says
    // nothing about this one.
    mergedHeadsRef.current.clear()
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, enabled, lane])

  useEffect(() => {
    if (typeof window === "undefined") return
    return subscribeWindowRegainedFocus(() => { void doFetch() })
  }, [doFetch])

  const revalidate = useCallback(() => {
    void doFetch()
  }, [doFetch])

  const revalidateCellStats = useCallback((cellId: string) => {
    const fid = fileRef.current
    if (!enabledRef.current || !fid) return
    const lane = laneRef.current
    void (async () => {
      try {
        const token = await tokenRef.current(fid)
        if (!token) return
        const stats = await fetchCellAuditStats(fid, cellId, token, lane)
        // The active file — or, AQU-1506, the active lane — may have changed
        // while this was in flight. Either makes the entry describe a view the
        // user is no longer on, and the lane switch has its own reload running.
        if (!stats || fileRef.current !== fid || laneRef.current !== lane) return
        mergedHeadsRef.current.set(stats.cellId, stats.lastEditEventId)
        setData((prev) => {
          const next = new Map(prev)
          next.set(stats.cellId, stats)
          return next
        })
      } catch (err) {
        console.warn("[useCellsAuditStats] cell revalidate failed:", err)
      }
    })()
  }, [])

  const applyCommittedCellStats = useCallback((cellId: string, rows: readonly CellRow[]): boolean => {
    if (!enabledRef.current || !fileRef.current) return false
    const lane = laneRef.current
    // Whether anything merges depends on the rows alone, so the caller has
    // its answer synchronously while the merge itself runs as an updater.
    const committedRow = committedStatsRow(cellId, rows, lane)
    if (!committedRow) return false
    mergedHeadsRef.current.set(cellId, committedRow.eventId)
    // AQU-2280: merge into React's latest map, never into a snapshot of it.
    // A ref mirroring `data` only catches up on the next render, and the
    // outbox drains the edits queued before a reload at the same moment the
    // file's full read returns. Copying the pre-read map here and setting it
    // threw the read's answer away for every other cell, so a whole file's
    // validation pills went blank until something else refetched.
    setData((prev) => {
      const stats = deriveCommittedCellStats(cellId, rows, lane, prev.get(cellId))
      if (!stats) return prev
      const next = new Map(prev)
      next.set(cellId, stats)
      return next
    })
    return true
  }, [])

  const applyValidationCellStats = useCallback((record: Pick<OutboxRecord, "event">): boolean => {
    const ev = record.event
    const cellId = ev.cellId
    if (!enabledRef.current || !fileRef.current || ev.fileId !== fileRef.current || !cellId) return false
    if (ev.kind !== "cell.validate" && ev.kind !== "cell.unvalidate") return false
    const payload = ev.payload as { editEventId?: string; targetLang?: string; targetUsername?: string }
    const lane = laneRef.current
    // Another lane's validation leaves this lane's entry as it is: settled,
    // with nothing to merge (the read it replaces would have said the same).
    if ((payload.targetLang ?? "") !== lane) return true
    // Removing someone else's approval is not what the overlay rule models.
    if (payload.targetUsername && payload.targetUsername !== ev.author) return false
    // The server counts a validator only against the cell's current head. The
    // entry is derived only when this client knows that head and it is the
    // edit the event names; anything else (a cell the sparse read left out, a
    // head a collaborator moved) keeps the read.
    const knownHead = mergedHeadsRef.current.has(cellId)
      ? mergedHeadsRef.current.get(cellId)
      : dataRef.current.get(cellId)?.lastEditEventId
    if (!payload.editEventId || knownHead !== payload.editEventId) return false
    setData((prev) => {
      // The same rule that drew this event while it was queued, applied to
      // the server map now that the server has applied it.
      const base = prev.get(cellId)
      const merged = applyOutboxOverlay({
        base: base ? new Map([[cellId, base]]) : new Map<string, CellAuditStats>(),
        pending: [record as OutboxRecord],
        lane,
      }).get(cellId)
      if (!merged) return prev
      const next = new Map(prev)
      next.set(cellId, merged)
      return next
    })
    return true
  }, [])

  return { byCellId: data, complete, isLoading, isError, revalidate, revalidateCellStats, applyCommittedCellStats, applyValidationCellStats }
}

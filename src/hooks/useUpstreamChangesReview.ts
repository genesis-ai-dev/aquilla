// AQU-478: data hook for the "Upstream changes" review panel.
//
// Composes three existing/new read surfaces (no new server aggregation route
// beyond the small `link/cursor-batches` addition — see that route's header
// comment for why it was genuinely needed):
//   1. `fetchStaleSourceResponse` (AQU-476, per file) — which target cells
//      are flagged (direct-stale or tombstoned) right now.
//   2. `fetchLinkCursorBatches` (AQU-478) — the mirror-sync batches, each
//      carrying the `source.cell.mirror` events it produced, so flagged
//      cells can be grouped by "when this changed" with an old→new diff.
//   3. `fetchCellsByIds` — the current target row (event_id, sourceEventId)
//      per flagged cell, needed for the repin emit's `expectedTargetEventId`.
//
// Old→new diff derivation: for a flagged (fileId, cellId), find its most
// recent `source.cell.mirror` event across all batches — that event's
// `payload.value` is the "new" text. The next-most-recent mirror event for
// the same cell (or, absent one, the cell's current *source*-side value
// before mirroring began) is the "old" text. Cells with only one mirror
// event show no meaningful "old" (first-ever mirror, e.g. post-seed) — the
// panel renders those as "new line" rather than a diff.

import { useCallback, useEffect, useRef, useState } from "react"
import { fetchStaleSourceResponse } from "@/lib/sync/stale-source-read"
import { fetchLinkCursorBatches } from "@/lib/sync/link-cursor-batches-read"
import { fetchCellsByIds } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { LinkCursorBatch } from "@/lib/sync/link-cursor-batches-read-types"
import type { FileReference } from "@/lib/parsers/types"

export type ReviewCategory = "changed" | "tombstoned"

export interface ReviewItem {
  fileId: string
  fileName: string
  cellId: string
  category: ReviewCategory
  /** Prior mirrored text, if a previous mirror batch touched this cell. */
  oldValue: string | null
  /** Current (latest mirrored) source text. Empty string for tombstones. */
  newValue: string
  /**
   * The LOCAL `source.cell.mirror` event id that produced `newValue`. After
   * that mirror lands, `cells.event_id` for this project's source row equals
   * this id — it is the value a repin must pin the target's
   * `source_event_id` to (NOT the upstream project's own event id, which
   * lives in a different project's `cells` table). Null for a tombstone
   * (nothing to pin to) or when no mirror event was found for this cell
   * (rare self-contained-project drift; repin is disabled in that case).
   */
  newSourceEventId: string | null
  /** The batch this change belongs to (most recent mirror touching the cell). */
  batchId: string
  batchServerTs: number
  /** Current target row, when the target has been translated. Null if the
   *  upstream cell has no downstream translation yet ("awaiting upstream
   *  translation" per the design spec §2). */
  target: {
    eventId: string
    sourceEventId: string | null
    value: string
  } | null
}

export interface ReviewBatchGroup {
  batchId: string
  serverTs: number
  cellCount: number
  items: ReviewItem[]
}

export interface UseUpstreamChangesReviewResult {
  groups: ReviewBatchGroup[]
  /** Flat count across all groups — convenience for a summary badge. */
  totalFlagged: number
  isLoading: boolean
  isError: boolean
  revalidate: () => void
}

export interface UseUpstreamChangesReviewOptions {
  projectId: string | null
  files: readonly Pick<FileReference, "id" | "name">[]
  getToken: (fileId: string) => Promise<string | null>
  enabled?: boolean
}

const REVIEW_LOAD_CONCURRENCY = 6

interface StaleFileState {
  stale: Set<string>
  tombstoned: Set<string>
}

type StaleResponseFetcher = typeof fetchStaleSourceResponse

/**
 * Load every file's upstream state with a small worker pool. A missing token
 * or failed file read rejects the complete scan: callers must never publish a
 * partial result as "Nothing flagged".
 */
export async function loadUpstreamStaleFiles(
  projectId: string,
  files: readonly Pick<FileReference, "id" | "name">[],
  getToken: (fileId: string) => Promise<string | null>,
  fetchStale: StaleResponseFetcher = fetchStaleSourceResponse,
): Promise<{ staleByFile: Map<string, StaleFileState>; projectToken: string | null }> {
  const states = new Array<[string, StaleFileState]>(files.length)
  const tokens = new Array<string>(files.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++
      if (index >= files.length) return
      const file = files[index]
      const jwt = await getToken(file.id)
      if (!jwt) throw new Error(`Couldn't get a read token for ${file.name}.`)
      const response = await fetchStale(projectId, file.id, jwt)
      tokens[index] = jwt
      states[index] = [file.id, {
        stale: new Set(response.staleCellIds ?? []),
        tombstoned: new Set(response.tombstonedCellIds ?? []),
      }]
    }
  }

  const workerCount = Math.min(REVIEW_LOAD_CONCURRENCY, files.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return {
    staleByFile: new Map(states),
    projectToken: tokens.find(Boolean) ?? null,
  }
}

export function useUpstreamChangesReview(
  opts: UseUpstreamChangesReviewOptions,
): UseUpstreamChangesReviewResult {
  const { projectId, files, getToken, enabled = true } = opts
  const [groups, setGroups] = useState<ReviewBatchGroup[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)
  const generationRef = useRef(0)

  const filesRef = useRef(files)
  filesRef.current = files
  const tokenRef = useRef(getToken)
  tokenRef.current = getToken

  const doFetch = useCallback(async () => {
    if (!enabled || !projectId) {
      setGroups([])
      setIsLoading(false)
      setIsError(false)
      return
    }
    const activeProjectId = projectId
    const gen = ++generationRef.current
    setIsLoading(true)
    setIsError(false)
    try {
      const scanFiles = filesRef.current
      if (scanFiles.length === 0) {
        if (generationRef.current === gen) {
          setGroups([])
          setIsLoading(false)
        }
        return
      }

      // 1. Per-file stale-source (parallel). Each file needs its own
      //    file-scoped token (sync-token claims are minted per fileId).
      const { staleByFile, projectToken } = await loadUpstreamStaleFiles(
        activeProjectId,
        scanFiles,
        tokenRef.current,
      )
      if (generationRef.current !== gen) return

      if (!projectToken) {
        setGroups([])
        setIsLoading(false)
        setIsError(true)
        return
      }

      // 2. Mirror-sync batches (project-scoped; any file-scoped token works —
      //    verifyTokenForProject only checks the projectId claim).
      const batchesRes = await fetchLinkCursorBatches(activeProjectId, projectToken)
      if (generationRef.current !== gen) return

      // Build, per (fileId, cellId), the ordered list of mirror events across
      // ALL batches (oldest first) so we can pick "latest" (new) and
      // "second-latest" (old) per flagged cell.
      type MirrorTouch = { batch: LinkCursorBatch; eventId: string; value: string; deleted: boolean }
      const touchesByCell = new Map<string, MirrorTouch[]>()
      const batchesAsc = [...batchesRes.batches].sort((a, b) => a.serverTs - b.serverTs)
      for (const batch of batchesAsc) {
        for (const evt of batch.events) {
          if (evt.kind !== "source.cell.mirror" || !evt.fileId || !evt.cellId) continue
          const key = `${evt.fileId} ${evt.cellId}`
          const payload = evt.payload as { value?: string; deleted?: true } | null
          const list = touchesByCell.get(key) ?? []
          list.push({ batch, eventId: evt.id, value: payload?.value ?? "", deleted: payload?.deleted === true })
          touchesByCell.set(key, list)
        }
      }

      // 3. Build the flagged-cell list (per file, per category), then fetch
      //    the current target row for each so the panel + repin action have
      //    eventId/sourceEventId/value.
      interface PendingItem {
        fileId: string
        fileName: string
        cellId: string
        category: ReviewCategory
      }
      const pending: PendingItem[] = []
      for (const f of scanFiles) {
        const entry = staleByFile.get(f.id)
        if (!entry) continue
        for (const cellId of entry.stale) {
          if (entry.tombstoned.has(cellId)) continue // tombstone takes priority below
          pending.push({ fileId: f.id, fileName: f.name, cellId, category: "changed" })
        }
        for (const cellId of entry.tombstoned) {
          pending.push({ fileId: f.id, fileName: f.name, cellId, category: "tombstoned" })
        }
      }

      const targetByKey = new Map<string, CellRow>()
      const byFile = new Map<string, string[]>()
      for (const p of pending) {
        const arr = byFile.get(p.fileId) ?? []
        arr.push(p.cellId)
        byFile.set(p.fileId, arr)
      }
      const targetEntries = [...byFile.entries()]
      let nextTargetIndex = 0
      async function loadTargetWorker(): Promise<void> {
        while (true) {
          const index = nextTargetIndex++
          if (index >= targetEntries.length) return
          const [fileId, cellIds] = targetEntries[index]
          const jwt = await tokenRef.current(fileId)
          if (!jwt) throw new Error(`Couldn't get a target read token for file ${fileId}.`)
          const rows = await fetchCellsByIds(activeProjectId, fileId, cellIds, jwt)
          for (const row of rows) {
            if (row.side !== "target") continue
            targetByKey.set(`${fileId} ${row.cellId}`, row)
          }
        }
      }
      await Promise.all(
        Array.from(
          { length: Math.min(REVIEW_LOAD_CONCURRENCY, targetEntries.length) },
          () => loadTargetWorker(),
        ),
      )
      if (generationRef.current !== gen) return

      // 4. Assemble ReviewItems, grouped by the LATEST batch that touched
      //    each cell (falls back to the file's first/only batch if the cell
      //    was never actually mirrored under the current stale set — a rare
      //    self-contained-project drift case per stale-source-route's own
      //    fallback path).
      const groupsByBatch = new Map<string, ReviewBatchGroup>()
      for (const p of pending) {
        const key = `${p.fileId} ${p.cellId}`
        const touches = touchesByCell.get(key) ?? []
        const latest = touches[touches.length - 1]
        const prior = touches.length > 1 ? touches[touches.length - 2] : undefined
        const batch = latest?.batch
        const target = targetByKey.get(key)

        const item: ReviewItem = {
          fileId: p.fileId,
          fileName: p.fileName,
          cellId: p.cellId,
          category: p.category,
          oldValue: prior ? prior.value : null,
          newValue: latest ? latest.value : "",
          // Tombstones have nothing to pin to; otherwise the latest mirror
          // event's OWN id becomes this project's source row's event_id.
          newSourceEventId: latest && !latest.deleted ? latest.eventId : null,
          batchId: batch?.batchId ?? "unknown",
          batchServerTs: batch?.serverTs ?? 0,
          target: target
            ? { eventId: target.eventId, sourceEventId: target.sourceEventId, value: target.value }
            : null,
        }

        const groupKey = item.batchId
        let group = groupsByBatch.get(groupKey)
        if (!group) {
          group = {
            batchId: item.batchId,
            serverTs: item.batchServerTs,
            cellCount: 0,
            items: [],
          }
          groupsByBatch.set(groupKey, group)
        }
        group.items.push(item)
        group.cellCount = group.items.length
      }

      const sortedGroups = [...groupsByBatch.values()].sort((a, b) => b.serverTs - a.serverTs)
      setGroups(sortedGroups)
      setIsLoading(false)
    } catch (err) {
      if (generationRef.current !== gen) return
      console.warn("[useUpstreamChangesReview] fetch failed:", err)
      setGroups([])
      setIsError(true)
      setIsLoading(false)
    }
  }, [projectId, enabled])

  useEffect(() => {
    void doFetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, enabled, files.length])

  const totalFlagged = groups.reduce((sum, g) => sum + g.items.length, 0)

  return { groups, totalFlagged, isLoading, isError, revalidate: doFetch }
}

// Phase 2b: this hook builds an *in-memory* DualIndex from `CellData[]`
// — the array already comes from the sync-worker projection via useCells,
// so no Y.Doc dependency here. Distinct from the user-facing project
// search (`useWorkspaceSearch` — server FTS5) because this index serves
// LLM example retrieval (branching-search semantics over source values for
// few-shot completion), which is a per-call hot path that can't tolerate a
// network round-trip. Kept client-side for that latency reason.

import { useEffect, useRef, useCallback } from "react"
import { DualIndex, type ScoredPair } from "@/lib/search/dual-index"
import { effectiveSourceText } from "@/lib/cell-text"
import { memMark } from "@/lib/perf-log"
import type { FileReference } from "@/lib/parsers/types"
import type { CellData } from "./useCells"

export interface PassageHit {
  fileId: string
  // File-order rows. `hit` marks which one was the branching-search match —
  // useful for UI (highlighting) but not load-bearing for the prompt.
  cells: { cellId: string; source: string; target: string; hit: boolean }[]
}

/**
 * Builds a project-wide DualIndex from all cells across all files. Exposes:
 *   - `search`: top-N branching-search hits (single-cell completion path)
 *   - `searchPassages`: same hits expanded with ±radius file-order neighbors,
 *     overlapping windows merged. Used by segmented batch translation so each
 *     few-shot example is a mini-passage instead of an isolated cell.
 *
 * `allProjectCells` must be in file-order (which is how `ProjectWorkspace`
 * builds it via the file's `order` array).
 */
export function useSearchIndex(_files: FileReference[], allProjectCells: CellData[]) {
  const indexRef = useRef(new DualIndex())
  const fileOrderRef = useRef<Map<string, string[]>>(new Map())
  const lookupRef = useRef<Map<string, { fileId: string; source: string; target: string }>>(new Map())

  useEffect(() => {
    // SUB-28: the index + passage lookup carry the SEMANTIC source — a
    // validated media section is indexed by its transcript, never the import
    // filename, and an untranscribed one stays out entirely.
    indexRef.current.buildFromProject(
      allProjectCells
        .filter((c) => c.status === "validated" && effectiveSourceText(c).trim() !== "")
        .map((c) => ({
          id: c.id,
          original: effectiveSourceText(c),
          translated: c.translated,
          fileId: c.fileId,
        })),
    )
    const order = new Map<string, string[]>()
    const lookup = new Map<string, { fileId: string; source: string; target: string }>()
    for (const c of allProjectCells) {
      if (c.status !== "validated") continue
      const src = effectiveSourceText(c)
      if (!src.trim()) continue
      let arr = order.get(c.fileId)
      if (!arr) { arr = []; order.set(c.fileId, arr) }
      arr.push(c.id)
      lookup.set(c.id, { fileId: c.fileId, source: src, target: c.translated })
    }
    fileOrderRef.current = order
    lookupRef.current = lookup
    memMark("useSearchIndex.build")
  }, [allProjectCells])

  // `excludeId` skips a specific cell from the result — used by completion to
  // keep the cell-being-translated out of its own few-shot examples (otherwise
  // a re-completion of an already-translated cell sees its own (source, target)
  // pair and the model just echoes the existing translation back).
  const search = useCallback((query: string, limit = 5, excludeId?: string): ScoredPair[] => {
    if (!excludeId) return indexRef.current.searchBranchingSource(query, limit)
    const raw = indexRef.current.searchBranchingSource(query, limit + 1)
    const filtered = raw.filter((p) => p.cellId !== excludeId)
    return filtered.length > limit ? filtered.slice(0, limit) : filtered
  }, [])

  const searchPassages = useCallback((query: string, hits = 3, radius = 2): PassageHit[] => {
    const results = indexRef.current.searchBranchingSource(query, hits)
    return expandToPassages(results, fileOrderRef.current, lookupRef.current, radius)
  }, [])

  return { search, searchPassages, index: indexRef.current }
}

// Expands branching-search hits into file-order windows of ±radius, merging
// overlapping windows from hits in the same file so the model doesn't see
// duplicate rows. Filled cells only (empty target → skipped) — an unfilled
// neighbor isn't useful as a translation example.
function expandToPassages(
  hits: ScoredPair[],
  fileOrder: Map<string, string[]>,
  lookup: Map<string, { fileId: string; source: string; target: string }>,
  radius: number,
): PassageHit[] {
  const byFile = new Map<string, { hitIds: Set<string>; ranges: Array<[number, number]> }>()
  for (const h of hits) {
    const order = fileOrder.get(h.fileId)
    if (!order) continue
    const idx = order.indexOf(h.cellId)
    if (idx < 0) continue
    let entry = byFile.get(h.fileId)
    if (!entry) { entry = { hitIds: new Set(), ranges: [] }; byFile.set(h.fileId, entry) }
    entry.hitIds.add(h.cellId)
    entry.ranges.push([Math.max(0, idx - radius), Math.min(order.length - 1, idx + radius)])
  }

  const passages: PassageHit[] = []
  for (const [fileId, { hitIds, ranges }] of byFile) {
    const order = fileOrder.get(fileId)!
    // Merge overlapping/adjacent windows.
    ranges.sort((a, b) => a[0] - b[0])
    const merged: Array<[number, number]> = []
    for (const r of ranges) {
      const last = merged[merged.length - 1]
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
      else merged.push([r[0], r[1]])
    }
    for (const [lo, hi] of merged) {
      const cells: PassageHit["cells"] = []
      for (let i = lo; i <= hi; i++) {
        const id = order[i]
        const c = lookup.get(id)
        if (!c || !c.source.trim() || !c.target.trim()) continue
        cells.push({ cellId: id, source: c.source, target: c.target, hit: hitIds.has(id) })
      }
      if (cells.length) passages.push({ fileId, cells })
    }
  }
  return passages
}

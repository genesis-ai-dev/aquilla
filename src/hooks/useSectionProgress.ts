import { useEffect, useState } from "react"
import { fetchAllFileCells } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { computeSectionProgress, type SectionProgress } from "@/lib/progress/section-progress"

/**
 * Compute section progress for one file by fetching paired source+target rows
 * from the sync-worker `cells` projection. Post-Phase-2c-β the importer no
 * longer writes a Y.Doc, so the legacy IDB-backed read path returns nothing —
 * sections must come from D1.
 *
 * Returns null while loading, [] when the file has no section-bearing cells,
 * SectionProgress[] otherwise. Errors degrade to []: a missing sub-list is
 * less confusing in the sidebar than a "Loading…" that never resolves.
 */
export function useSectionProgress(
  projectId: string | null,
  fileId: string | null,
  validationCount: number,
  getTokenForFile: ((fileId: string) => Promise<string | null>) | undefined,
): SectionProgress[] | null {
  const [sections, setSections] = useState<SectionProgress[] | null>(null)

  useEffect(() => {
    if (!projectId || !fileId || !getTokenForFile) {
      setSections(null)
      return
    }
    let cancelled = false
    setSections(null)
    void (async () => {
      try {
        const token = await getTokenForFile(fileId)
        if (cancelled) return
        if (!token) {
          setSections([])
          return
        }
        const rows = await fetchAllFileCells(projectId, fileId, token)
        if (cancelled) return
        setSections(computeSectionProgress(rowsToProgressCells(rows), validationCount))
      } catch (err) {
        console.warn("[useSectionProgress] fetch failed:", err)
        if (!cancelled) setSections([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, fileId, validationCount, getTokenForFile])

  return sections
}

/**
 * Reduce paired source+target CellRow pairs to the shape computeSectionProgress
 * needs. We use canonical_ref as the section key (it carries "BOOK CH:V" for
 * scripture); the target row's value drives the "translated" completion bar,
 * the target's validated flag drives "active validators" (single slot per
 * cell in the projection — full validator history lands when that grammar
 * does).
 */
function rowsToProgressCells(rows: CellRow[]): {
  id: string
  group: string
  section?: string
  globalReferences?: string[]
  translated: string
  activeValidators: string[]
}[] {
  const sources = new Map<string, CellRow>()
  const targets = new Map<string, CellRow>()
  const seen: string[] = []
  for (const row of rows) {
    if (row.side === "source") {
      if (!sources.has(row.cellId)) seen.push(row.cellId)
      sources.set(row.cellId, row)
    } else {
      targets.set(row.cellId, row)
    }
  }
  return seen.map((cellId) => {
    const source = sources.get(cellId)
    const target = targets.get(cellId)
    const canonical = target?.canonicalRef ?? source?.canonicalRef ?? null
    return {
      id: cellId,
      group: "",
      section: canonical ? sectionLabelFromCanonical(canonical) : undefined,
      globalReferences: canonical ? [canonical] : undefined,
      translated: target?.value ?? "",
      activeValidators: target?.validated ? [target.lastEditor ?? "unknown"] : [],
    }
  })
}

function sectionLabelFromCanonical(ref: string): string {
  const colonIdx = ref.indexOf(":")
  return (colonIdx >= 0 ? ref.slice(0, colonIdx) : ref).trim()
}

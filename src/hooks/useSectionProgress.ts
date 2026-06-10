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
    let retry: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    setSections(null)
    const run = async () => {
      try {
        const token = await getTokenForFile(fileId)
        if (cancelled) return
        if (!token) {
          // Auth race — keep `sections` null (loading) and retry with
          // backoff. After ~6 attempts fall back to [] so the sidebar
          // doesn't spin forever on a real permission failure.
          attempt++
          if (attempt >= 6) {
            setSections([])
            return
          }
          const delay = Math.min(4000, 250 * 2 ** (attempt - 1))
          retry = setTimeout(() => { retry = null; void run() }, delay)
          return
        }
        const rows = await fetchAllFileCells(projectId, fileId, token)
        if (cancelled) return
        setSections(computeSectionProgress(rowsToProgressCells(rows), validationCount))
      } catch (err) {
        console.warn("[useSectionProgress] fetch failed:", err)
        if (!cancelled) setSections([])
      }
    }
    void run()
    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
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
  validated: boolean
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
      // FRO-280 (audit F-P2): pass the server-projected flag directly so
      // computeSectionProgress consumes it instead of re-deriving from
      // activeValidators. The activeValidators slot is left empty here because
      // the projection does not return per-cell validator lists — only the
      // aggregate threshold gate. The textValidationLevels multi-bar relies on
      // activeValidators.length, but without individual validator identities
      // from the server we cannot populate it; it stays at the single-slot
      // level-0 bar (% of cells with validated=true). Full per-validator
      // decomposition is deferred to when the validator-list grammar lands.
      activeValidators: [],
      validated: target?.validated ?? false,
    }
  })
}

function sectionLabelFromCanonical(ref: string): string {
  const colonIdx = ref.indexOf(":")
  return (colonIdx >= 0 ? ref.slice(0, colonIdx) : ref).trim()
}

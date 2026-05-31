/**
 * useLivingMemory — aggregate validated cells across all files of a project.
 *
 * Design:
 *   - Reads the project's file list from useProject (same source as
 *     ProjectWorkspace). No server endpoint needed for this count of files
 *     (typically <200). Each file is fetched individually via useCells.
 *   - Filtering is pure (filterValidated / sortValidated) so it can be
 *     unit-tested without hooks.
 *
 * SWARM-TODO(living-mem-server): at scale (thousands of files or tens of
 *   thousands of validated cells) the N×useCells fan-out is expensive.
 *   A dedicated endpoint — GET /api/v2/projects/:projectId/validated-cells
 *   returning { fileId, cellId, original, translated, activeValidators,
 *   canonicalRef, lastEditAt } — would replace the fan-out. Shape is
 *   intentionally close to CellData so the hook stays compatible.
 */

import { useMemo } from "react"
import type { CellData } from "@/hooks/useCells"
import { useCells } from "@/hooks/useCells"
import { useProject } from "@/hooks/useProject"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"

// ── Pure helpers (testable without hooks) ─────────────────────────────────

/** Return only cells that have been validated. */
export function filterValidated(cells: CellData[]): CellData[] {
  return cells.filter((c) => c.status === "validated")
}

/**
 * Sort validated cells by descending recency (most-recently-edited first).
 * Falls back to group (canonicalRef) / id order for cells where `lastEditAt`
 * is absent so the list remains deterministic.
 */
export function sortValidated<T extends CellData>(cells: T[]): T[] {
  return [...cells].sort((a, b) => {
    const at = a.lastEditAt ?? 0
    const bt = b.lastEditAt ?? 0
    if (bt !== at) return bt - at   // descending recency
    const ag = a.group || a.id
    const bg = b.group || b.id
    if (ag < bg) return -1
    if (ag > bg) return 1
    return 0
  })
}

// ── Per-file cell loader (used by the fan-out below) ──────────────────────

interface FileCellsHookOpts {
  projectId: string | null
  fileId: string | null
  getToken: (fileId: string) => Promise<string | null>
  enabled: boolean
}

/**
 * Load cells for a single file and return only validated ones.
 * Internal hook used by useLivingMemoryFiles.
 */
function useFileValidatedCells({ projectId, fileId, getToken, enabled }: FileCellsHookOpts): {
  cells: CellData[]
  isLoading: boolean
} {
  const { cells, isLoading } = useCells({
    projectId,
    fileId,
    getToken,
    enabled,
  })
  const validated = useMemo(() => filterValidated(cells), [cells])
  return { cells: validated, isLoading }
}

// React prohibits dynamic hook calls (array.map over hooks), so we unroll up
// to MAX_FILES files. Projects with more files will see validated cells from
// the first MAX_FILES files only — this is explicitly surfaced in the UI.
const MAX_FILES = 40

function useFileCellSlot(
  projectId: string | null,
  fileId: string | null,
  getToken: (fileId: string) => Promise<string | null>,
  enabled: boolean,
) {
  return useFileValidatedCells({ projectId, fileId, getToken, enabled })
}

// One hook call per slot. We need exactly MAX_FILES unconditional hook calls.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function useAllFileSlots(
  projectId: string | null,
  fileIds: readonly string[],
  getToken: (fileId: string) => Promise<string | null>,
  enabled: boolean,
) {
  // Intentionally unrolled — React requires a fixed number of hook calls.
  const s0 = useFileCellSlot(projectId, fileIds[0] ?? null, getToken, enabled && !!fileIds[0])
  const s1 = useFileCellSlot(projectId, fileIds[1] ?? null, getToken, enabled && !!fileIds[1])
  const s2 = useFileCellSlot(projectId, fileIds[2] ?? null, getToken, enabled && !!fileIds[2])
  const s3 = useFileCellSlot(projectId, fileIds[3] ?? null, getToken, enabled && !!fileIds[3])
  const s4 = useFileCellSlot(projectId, fileIds[4] ?? null, getToken, enabled && !!fileIds[4])
  const s5 = useFileCellSlot(projectId, fileIds[5] ?? null, getToken, enabled && !!fileIds[5])
  const s6 = useFileCellSlot(projectId, fileIds[6] ?? null, getToken, enabled && !!fileIds[6])
  const s7 = useFileCellSlot(projectId, fileIds[7] ?? null, getToken, enabled && !!fileIds[7])
  const s8 = useFileCellSlot(projectId, fileIds[8] ?? null, getToken, enabled && !!fileIds[8])
  const s9 = useFileCellSlot(projectId, fileIds[9] ?? null, getToken, enabled && !!fileIds[9])
  const s10 = useFileCellSlot(projectId, fileIds[10] ?? null, getToken, enabled && !!fileIds[10])
  const s11 = useFileCellSlot(projectId, fileIds[11] ?? null, getToken, enabled && !!fileIds[11])
  const s12 = useFileCellSlot(projectId, fileIds[12] ?? null, getToken, enabled && !!fileIds[12])
  const s13 = useFileCellSlot(projectId, fileIds[13] ?? null, getToken, enabled && !!fileIds[13])
  const s14 = useFileCellSlot(projectId, fileIds[14] ?? null, getToken, enabled && !!fileIds[14])
  const s15 = useFileCellSlot(projectId, fileIds[15] ?? null, getToken, enabled && !!fileIds[15])
  const s16 = useFileCellSlot(projectId, fileIds[16] ?? null, getToken, enabled && !!fileIds[16])
  const s17 = useFileCellSlot(projectId, fileIds[17] ?? null, getToken, enabled && !!fileIds[17])
  const s18 = useFileCellSlot(projectId, fileIds[18] ?? null, getToken, enabled && !!fileIds[18])
  const s19 = useFileCellSlot(projectId, fileIds[19] ?? null, getToken, enabled && !!fileIds[19])
  const s20 = useFileCellSlot(projectId, fileIds[20] ?? null, getToken, enabled && !!fileIds[20])
  const s21 = useFileCellSlot(projectId, fileIds[21] ?? null, getToken, enabled && !!fileIds[21])
  const s22 = useFileCellSlot(projectId, fileIds[22] ?? null, getToken, enabled && !!fileIds[22])
  const s23 = useFileCellSlot(projectId, fileIds[23] ?? null, getToken, enabled && !!fileIds[23])
  const s24 = useFileCellSlot(projectId, fileIds[24] ?? null, getToken, enabled && !!fileIds[24])
  const s25 = useFileCellSlot(projectId, fileIds[25] ?? null, getToken, enabled && !!fileIds[25])
  const s26 = useFileCellSlot(projectId, fileIds[26] ?? null, getToken, enabled && !!fileIds[26])
  const s27 = useFileCellSlot(projectId, fileIds[27] ?? null, getToken, enabled && !!fileIds[27])
  const s28 = useFileCellSlot(projectId, fileIds[28] ?? null, getToken, enabled && !!fileIds[28])
  const s29 = useFileCellSlot(projectId, fileIds[29] ?? null, getToken, enabled && !!fileIds[29])
  const s30 = useFileCellSlot(projectId, fileIds[30] ?? null, getToken, enabled && !!fileIds[30])
  const s31 = useFileCellSlot(projectId, fileIds[31] ?? null, getToken, enabled && !!fileIds[31])
  const s32 = useFileCellSlot(projectId, fileIds[32] ?? null, getToken, enabled && !!fileIds[32])
  const s33 = useFileCellSlot(projectId, fileIds[33] ?? null, getToken, enabled && !!fileIds[33])
  const s34 = useFileCellSlot(projectId, fileIds[34] ?? null, getToken, enabled && !!fileIds[34])
  const s35 = useFileCellSlot(projectId, fileIds[35] ?? null, getToken, enabled && !!fileIds[35])
  const s36 = useFileCellSlot(projectId, fileIds[36] ?? null, getToken, enabled && !!fileIds[36])
  const s37 = useFileCellSlot(projectId, fileIds[37] ?? null, getToken, enabled && !!fileIds[37])
  const s38 = useFileCellSlot(projectId, fileIds[38] ?? null, getToken, enabled && !!fileIds[38])
  const s39 = useFileCellSlot(projectId, fileIds[39] ?? null, getToken, enabled && !!fileIds[39])

  return [
    s0, s1, s2, s3, s4, s5, s6, s7, s8, s9,
    s10, s11, s12, s13, s14, s15, s16, s17, s18, s19,
    s20, s21, s22, s23, s24, s25, s26, s27, s28, s29,
    s30, s31, s32, s33, s34, s35, s36, s37, s38, s39,
  ] as const
}

// ── Public hook ────────────────────────────────────────────────────────────

export interface LivingMemoryCell extends CellData {
  /** The human-readable file name the cell belongs to. */
  fileName: string
}

export interface UseLivingMemoryResult {
  /** Sorted list of validated cells across all project files. */
  cells: LivingMemoryCell[]
  /** True while at least one file is still loading. */
  isLoading: boolean
  /** True when the project has no validated cells. */
  isEmpty: boolean
  /** True when more than MAX_FILES files exist — cells from overflow files
   *  are not shown. */
  isTruncated: boolean
  /** Number of files in the project (capped to what was loaded). */
  fileCount: number
}

export function useLivingMemory({ projectId }: { projectId: string }): UseLivingMemoryResult {
  const { session } = useFrontierSession()
  const { project, status } = useProject(projectId)

  const projectFiles = project?.files ?? []
  const cappedFiles = projectFiles.slice(0, MAX_FILES)
  const isTruncated = projectFiles.length > MAX_FILES

  const getToken = useMemo(() => {
    if (!projectId || !session?.jwt) {
      return async (_fileId: string) => null as string | null
    }
    return buildFileScopedTokenFetcher(() => session.jwt, projectId)
  }, [projectId, session?.jwt])

  const fileIds = useMemo(
    () => cappedFiles.map((f) => f.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cappedFiles.map((f) => f.id).join(",")],
  )

  const fileEnabled = status === "ready" && !!session?.jwt

  const slots = useAllFileSlots(projectId, fileIds, getToken, fileEnabled)

  const { cells, isLoading } = useMemo(() => {
    const fileNameById = new Map(cappedFiles.map((f) => [f.id, f.name]))
    let anyLoading = status === "loading"
    const all: LivingMemoryCell[] = []

    for (let i = 0; i < cappedFiles.length; i++) {
      const slot = slots[i]
      if (slot.isLoading) anyLoading = true
      for (const cell of slot.cells) {
        all.push({ ...cell, fileName: fileNameById.get(cell.fileId) ?? cell.fileId })
      }
    }

    return { cells: sortValidated(all), isLoading: anyLoading }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    status,
    cappedFiles,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ...slots.map((s) => s.cells),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ...slots.map((s) => s.isLoading),
  ])

  return {
    cells,
    isLoading,
    isEmpty: !isLoading && cells.length === 0,
    isTruncated,
    fileCount: cappedFiles.length,
  }
}

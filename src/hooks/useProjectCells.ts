/**
 * useProjectCells — load cells for every file in a project, keyed by file,
 * for use by project-scope client-side export.
 *
 * Design mirrors useLivingMemory's unrolled fan-out (React rules-of-hooks
 * forbid dynamic arrays of hook calls). We support up to MAX_FILES = 40 files;
 * projects with more files will see cells from the first 40 only, and
 * `isTruncated` will be set. A SWARM-TODO marks the shape for a future server
 * batch endpoint.
 *
 * SWARM-TODO(project-export-scale): at scale (> 40 files) the N×useCells
 *   fan-out becomes impractical. A dedicated endpoint —
 *   GET /api/v2/projects/:projectId/cells?format=tsv
 *   — that streams all files' cells server-side and returns a pre-built zip
 *   would replace the fan-out. The endpoint shape should accept the same
 *   ExportFormat values so the server handles the serialization too.
 */

import { useMemo } from "react"
import type { CellData } from "@/hooks/useCells"
import { useCells } from "@/hooks/useCells"

// ── Per-file cell loader ───────────────────────────────────────────────────

interface FileSlotOpts {
  projectId: string | null
  fileId: string | null
  getToken: (fileId: string) => Promise<string | null>
  enabled: boolean
}

function useFileCellSlot({ projectId, fileId, getToken, enabled }: FileSlotOpts): {
  cells: CellData[]
  isLoading: boolean
} {
  const { cells, isLoading } = useCells({ projectId, fileId, getToken, enabled })
  return { cells, isLoading }
}

// React prohibits dynamic hook counts. Unroll exactly MAX_FILES slots.
const MAX_FILES = 40

function useAllFileSlots(
  projectId: string | null,
  fileIds: readonly string[],
  getToken: (fileId: string) => Promise<string | null>,
  enabled: boolean,
) {
  // Each slot is a fixed, unconditional hook call. Slots beyond the actual
  // file count are disabled (enabled=false) and return empty cells.
  const s0  = useFileCellSlot({ projectId, fileId: fileIds[0]  ?? null, getToken, enabled: enabled && !!fileIds[0] })
  const s1  = useFileCellSlot({ projectId, fileId: fileIds[1]  ?? null, getToken, enabled: enabled && !!fileIds[1] })
  const s2  = useFileCellSlot({ projectId, fileId: fileIds[2]  ?? null, getToken, enabled: enabled && !!fileIds[2] })
  const s3  = useFileCellSlot({ projectId, fileId: fileIds[3]  ?? null, getToken, enabled: enabled && !!fileIds[3] })
  const s4  = useFileCellSlot({ projectId, fileId: fileIds[4]  ?? null, getToken, enabled: enabled && !!fileIds[4] })
  const s5  = useFileCellSlot({ projectId, fileId: fileIds[5]  ?? null, getToken, enabled: enabled && !!fileIds[5] })
  const s6  = useFileCellSlot({ projectId, fileId: fileIds[6]  ?? null, getToken, enabled: enabled && !!fileIds[6] })
  const s7  = useFileCellSlot({ projectId, fileId: fileIds[7]  ?? null, getToken, enabled: enabled && !!fileIds[7] })
  const s8  = useFileCellSlot({ projectId, fileId: fileIds[8]  ?? null, getToken, enabled: enabled && !!fileIds[8] })
  const s9  = useFileCellSlot({ projectId, fileId: fileIds[9]  ?? null, getToken, enabled: enabled && !!fileIds[9] })
  const s10 = useFileCellSlot({ projectId, fileId: fileIds[10] ?? null, getToken, enabled: enabled && !!fileIds[10] })
  const s11 = useFileCellSlot({ projectId, fileId: fileIds[11] ?? null, getToken, enabled: enabled && !!fileIds[11] })
  const s12 = useFileCellSlot({ projectId, fileId: fileIds[12] ?? null, getToken, enabled: enabled && !!fileIds[12] })
  const s13 = useFileCellSlot({ projectId, fileId: fileIds[13] ?? null, getToken, enabled: enabled && !!fileIds[13] })
  const s14 = useFileCellSlot({ projectId, fileId: fileIds[14] ?? null, getToken, enabled: enabled && !!fileIds[14] })
  const s15 = useFileCellSlot({ projectId, fileId: fileIds[15] ?? null, getToken, enabled: enabled && !!fileIds[15] })
  const s16 = useFileCellSlot({ projectId, fileId: fileIds[16] ?? null, getToken, enabled: enabled && !!fileIds[16] })
  const s17 = useFileCellSlot({ projectId, fileId: fileIds[17] ?? null, getToken, enabled: enabled && !!fileIds[17] })
  const s18 = useFileCellSlot({ projectId, fileId: fileIds[18] ?? null, getToken, enabled: enabled && !!fileIds[18] })
  const s19 = useFileCellSlot({ projectId, fileId: fileIds[19] ?? null, getToken, enabled: enabled && !!fileIds[19] })
  const s20 = useFileCellSlot({ projectId, fileId: fileIds[20] ?? null, getToken, enabled: enabled && !!fileIds[20] })
  const s21 = useFileCellSlot({ projectId, fileId: fileIds[21] ?? null, getToken, enabled: enabled && !!fileIds[21] })
  const s22 = useFileCellSlot({ projectId, fileId: fileIds[22] ?? null, getToken, enabled: enabled && !!fileIds[22] })
  const s23 = useFileCellSlot({ projectId, fileId: fileIds[23] ?? null, getToken, enabled: enabled && !!fileIds[23] })
  const s24 = useFileCellSlot({ projectId, fileId: fileIds[24] ?? null, getToken, enabled: enabled && !!fileIds[24] })
  const s25 = useFileCellSlot({ projectId, fileId: fileIds[25] ?? null, getToken, enabled: enabled && !!fileIds[25] })
  const s26 = useFileCellSlot({ projectId, fileId: fileIds[26] ?? null, getToken, enabled: enabled && !!fileIds[26] })
  const s27 = useFileCellSlot({ projectId, fileId: fileIds[27] ?? null, getToken, enabled: enabled && !!fileIds[27] })
  const s28 = useFileCellSlot({ projectId, fileId: fileIds[28] ?? null, getToken, enabled: enabled && !!fileIds[28] })
  const s29 = useFileCellSlot({ projectId, fileId: fileIds[29] ?? null, getToken, enabled: enabled && !!fileIds[29] })
  const s30 = useFileCellSlot({ projectId, fileId: fileIds[30] ?? null, getToken, enabled: enabled && !!fileIds[30] })
  const s31 = useFileCellSlot({ projectId, fileId: fileIds[31] ?? null, getToken, enabled: enabled && !!fileIds[31] })
  const s32 = useFileCellSlot({ projectId, fileId: fileIds[32] ?? null, getToken, enabled: enabled && !!fileIds[32] })
  const s33 = useFileCellSlot({ projectId, fileId: fileIds[33] ?? null, getToken, enabled: enabled && !!fileIds[33] })
  const s34 = useFileCellSlot({ projectId, fileId: fileIds[34] ?? null, getToken, enabled: enabled && !!fileIds[34] })
  const s35 = useFileCellSlot({ projectId, fileId: fileIds[35] ?? null, getToken, enabled: enabled && !!fileIds[35] })
  const s36 = useFileCellSlot({ projectId, fileId: fileIds[36] ?? null, getToken, enabled: enabled && !!fileIds[36] })
  const s37 = useFileCellSlot({ projectId, fileId: fileIds[37] ?? null, getToken, enabled: enabled && !!fileIds[37] })
  const s38 = useFileCellSlot({ projectId, fileId: fileIds[38] ?? null, getToken, enabled: enabled && !!fileIds[38] })
  const s39 = useFileCellSlot({ projectId, fileId: fileIds[39] ?? null, getToken, enabled: enabled && !!fileIds[39] })

  return [
    s0, s1, s2, s3, s4, s5, s6, s7, s8, s9,
    s10, s11, s12, s13, s14, s15, s16, s17, s18, s19,
    s20, s21, s22, s23, s24, s25, s26, s27, s28, s29,
    s30, s31, s32, s33, s34, s35, s36, s37, s38, s39,
  ] as const
}

// ── Public hook ────────────────────────────────────────────────────────────

export interface ProjectFileCells {
  fileId: string
  fileName: string
  cells: CellData[]
}

export interface UseProjectCellsResult {
  /** Per-file cells, in the same order as projectFiles (first MAX_FILES). */
  files: ProjectFileCells[]
  /** True while any file is still loading. */
  isLoading: boolean
  /** True when the project has more than MAX_FILES files; cells from overflow
   *  files are not included. */
  isTruncated: boolean
}

export interface UseProjectCellsOpts {
  projectId: string | null
  projectFiles: { id: string; name: string; type: string }[]
  getToken: (fileId: string) => Promise<string | null>
  /** Pass false to defer fetching (e.g. while scope !== "project"). */
  enabled?: boolean
}

export function useProjectCells({
  projectId,
  projectFiles,
  getToken,
  enabled = true,
}: UseProjectCellsOpts): UseProjectCellsResult {
  const cappedFiles = projectFiles.slice(0, MAX_FILES)
  const isTruncated = projectFiles.length > MAX_FILES

  // Stable fileIds array (only re-derives when the joined id list changes).
  const fileIds = useMemo(
    () => cappedFiles.map((f) => f.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cappedFiles.map((f) => f.id).join(",")],
  )

  const slots = useAllFileSlots(projectId, fileIds, getToken, enabled)

  const { files, isLoading } = useMemo(() => {
    let anyLoading = false
    const result: ProjectFileCells[] = []
    for (let i = 0; i < cappedFiles.length; i++) {
      const slot = slots[i]
      if (slot.isLoading) anyLoading = true
      result.push({
        fileId: cappedFiles[i].id,
        fileName: cappedFiles[i].name,
        cells: slot.cells,
      })
    }
    return { files: result, isLoading: anyLoading }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cappedFiles,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ...slots.map((s) => s.cells),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ...slots.map((s) => s.isLoading),
  ])

  return { files, isLoading, isTruncated }
}

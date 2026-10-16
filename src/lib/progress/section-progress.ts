import type { CellData } from "@/hooks/useCells"
import { buildSectionIndex, type SectionInfo } from "./section-index"
import { progressPercent } from "./progress-percent"

export interface SectionProgress extends SectionInfo {
  textCompleted: number      // 0..100
  textValidated: number      // 0..100
  textValidationLevels: number[] // [% with ≥1 validator, % with ≥2, …] length = validationCount
  audioCompleted: number     // 0 until audio ships
  audioValidated: number
  audioValidationLevels: number[]
  hasAudio: boolean
}

type ProgressCell = Pick<CellData, "id" | "group" | "section" | "translated" | "activeValidators"> & {
  audioUrl?: string // present once audio support lands
  /**
   * Server-projected threshold gate (AQU-280 / audit F-P2).
   * Consumed in preference to re-deriving `activeValidators.length >= validationCount`
   * on the client. The sync-worker projection (AQU-279) makes this flag
   * threshold-aware, so `validated=true` already means "meets the project's
   * validationCount requirement." When absent (legacy or test fixtures that
   * haven't adopted the flag), falls back to the validator-count comparison so
   * callers that only supply `activeValidators` continue working.
   */
  validated?: boolean
}

const MAX_VALIDATION_LEVELS = 15

// AQU-1493: never 100 while a cell in the section is outstanding.
const pct = progressPercent

export function computeSectionProgress(
  cells: ProgressCell[],
  validationCount: number,
): SectionProgress[] {
  const sections = buildSectionIndex(cells)
  const byId = new Map<string, ProgressCell>()
  for (const c of cells) byId.set(c.id, c)

  const levelCap = Math.min(Math.max(validationCount, 1), MAX_VALIDATION_LEVELS)

  return sections.map((section) => {
    const sectionCells = section.cellIds.map((id) => byId.get(id)!).filter(Boolean)
    const total = sectionCells.length

    let completed = 0
    let validated = 0
    const levelCounts = new Array(levelCap).fill(0)
    let hasAudio = false

    for (const cell of sectionCells) {
      const translatedText = (cell.translated || "").trim()
      if (translatedText.length > 0) completed++

      const vCount = cell.activeValidators?.length ?? 0
      // AQU-280 (audit F-P2): consume the server-projected `validated` flag
      // rather than re-deriving the threshold on the client. The server
      // projection (AQU-279) already encodes `validationCount` so this flag
      // is authoritative. Falls back to the validator-count comparison only
      // when the field is absent (legacy/test fixtures that predate AQU-279).
      if (cell.validated !== undefined ? cell.validated : vCount >= validationCount) validated++

      // levelCounts[i] = cells with > i distinct validators (i.e. ≥ i+1)
      for (let i = 0; i < levelCap; i++) {
        if (vCount > i) levelCounts[i]++
      }

      if (cell.audioUrl && cell.audioUrl.length > 0) hasAudio = true
    }

    const textValidationLevels = levelCounts.map((n) => pct(n, total))

    return {
      label: section.label,
      cellIds: section.cellIds,
      textCompleted: pct(completed, total),
      textValidated: pct(validated, total),
      textValidationLevels,
      audioCompleted: 0,
      audioValidated: 0,
      audioValidationLevels: [],
      hasAudio,
    }
  })
}

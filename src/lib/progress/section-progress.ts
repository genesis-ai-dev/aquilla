import type { CellData } from "@/hooks/useCells"
import { buildSectionIndex, type SectionInfo } from "./section-index"

export interface SectionProgress extends SectionInfo {
  textCompleted: number      // 0..100
  textValidated: number      // 0..100
  textValidationLevels: number[] // [% with ≥1 validator, % with ≥2, …] length = validationCount
  audioCompleted: number     // 0 until audio ships
  audioValidated: number
  audioValidationLevels: number[]
  hasAudio: boolean
}

type ProgressCell = Pick<CellData, "id" | "group" | "translated" | "activeValidators"> & {
  audioUrl?: string // present once audio support lands
}

const MAX_VALIDATION_LEVELS = 15

function pct(num: number, denom: number): number {
  if (denom === 0) return 0
  return Math.round((num / denom) * 100)
}

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
      if (vCount >= validationCount) validated++

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

import type { CellData } from "@/hooks/useCells"

export interface HealthStats {
  healthMap: Map<string, number>      // cellId → 0-100
  fileHealth: Map<string, number>     // fileId → average health 0-100
  projectHealth: number               // overall average 0-100
  fileProgress: Map<string, { translated: number; validated: number; total: number }>
}

export function computeHealthMap(
  // All cells across all files, keyed by fileId
  fileCells: Map<string, CellData[]>
): HealthStats {
  const healthMap = new Map<string, number>()
  const fileHealth = new Map<string, number>()
  const fileProgress = new Map<string, { translated: number; validated: number; total: number }>()

  // First pass: compute health for all cells across all files
  // Process in natural order — examples always come before dependents
  for (const [, cells] of fileCells) {
    for (const cell of cells) {
      if (cell.status === "empty") continue
      if (cell.status === "validated") {
        healthMap.set(cell.id, 100)
        continue
      }
      // status === "unvalidated" (LLM-generated)
      const lastEntry = cell.history[cell.history.length - 1]
      const exampleIds = lastEntry?.examples || []
      if (exampleIds.length === 0) {
        healthMap.set(cell.id, 0)
        continue
      }
      let sum = 0
      for (const exId of exampleIds) {
        sum += healthMap.get(exId) ?? 0
      }
      healthMap.set(cell.id, Math.round(sum / exampleIds.length))
    }
  }

  // Second pass: file-level stats
  let projectSum = 0
  let projectCount = 0

  for (const [fileId, cells] of fileCells) {
    const total = cells.length
    const translated = cells.filter((c) => c.status !== "empty").length
    const validated = cells.filter((c) => c.status === "validated").length
    fileProgress.set(fileId, { translated, validated, total })

    // File health = average of all non-empty cell healths
    let fileSum = 0
    let fileCount = 0
    for (const cell of cells) {
      const h = healthMap.get(cell.id)
      if (h !== undefined) {
        fileSum += h
        fileCount += 1
      }
    }
    const avgHealth = fileCount > 0 ? Math.round(fileSum / fileCount) : 0
    fileHealth.set(fileId, avgHealth)
    projectSum += fileSum
    projectCount += fileCount
  }

  const projectHealth = projectCount > 0 ? Math.round(projectSum / projectCount) : 0

  return { healthMap, fileHealth, projectHealth, fileProgress }
}

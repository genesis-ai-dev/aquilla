import type { CellData } from "@/hooks/useCells"
import type { TranslationRule, RuleInfraction } from "@/lib/parsers/types"
import { checkRules } from "@/lib/rules/rule-engine"

export interface HealthStats {
  healthMap: Map<string, number>      // cellId → 0-100
  fileHealth: Map<string, number>     // fileId → average health 0-100
  projectHealth: number               // overall average 0-100
  fileProgress: Map<string, { translated: number; validated: number; total: number }>
  infractions: Map<string, RuleInfraction[]>
  openCommentCount: Map<string, number>
  projectOpenCommentCount: number
  cellOpenCommentCount: Map<string, number>
}

export const DEFAULT_LLM_HEALTH_MULTIPLIER = 0.9

export function computeHealthMap(
  fileCells: Map<string, CellData[]>,
  llmHealthMultiplier = DEFAULT_LLM_HEALTH_MULTIPLIER,
  rules: TranslationRule[] = [],
  rulePenalties: { major: number; minor: number } = { major: 15, minor: 5 }
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
      healthMap.set(cell.id, Math.round((sum / exampleIds.length) * llmHealthMultiplier))
    }
  }

  // Rule infractions pass
  const infractions = checkRules(fileCells, rules)

  // Build rule severity lookup
  const ruleSeverity = new Map<string, "major" | "minor">()
  for (const rule of rules) ruleSeverity.set(rule.id, rule.severity)

  // Apply penalties
  for (const [cellId, cellInfractions] of infractions) {
    const baseHealth = healthMap.get(cellId)
    if (baseHealth === undefined) continue
    let penalty = 0
    for (const inf of cellInfractions) {
      const severity = ruleSeverity.get(inf.ruleId) || "minor"
      penalty += severity === "major" ? rulePenalties.major : rulePenalties.minor
    }
    healthMap.set(cellId, Math.max(0, baseHealth - penalty))
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

  const openCommentCount = new Map<string, number>()
  const cellOpenCommentCount = new Map<string, number>()
  let projectOpenCommentCount = 0

  for (const [fileId, cellsList] of fileCells) {
    let fileCount = 0
    for (const cell of cellsList) {
      const cellThreads = cell.threads || []
      const openCount = cellThreads.filter((t) => t.status === "open").length
      if (openCount > 0) {
        cellOpenCommentCount.set(cell.id, openCount)
        fileCount += openCount
      }
    }
    openCommentCount.set(fileId, fileCount)
    projectOpenCommentCount += fileCount
  }

  return { healthMap, fileHealth, projectHealth, fileProgress, infractions, openCommentCount, projectOpenCommentCount, cellOpenCommentCount }
}

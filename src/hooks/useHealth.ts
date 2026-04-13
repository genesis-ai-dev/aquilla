import { useMemo } from "react"
import { computeHealthMap, type HealthStats } from "@/lib/health/health-engine"
import type { CellData } from "./useCells"
import type { TranslationRule, RulePenalties } from "@/lib/parsers/types"

export function useHealth(
  fileCells: Map<string, CellData[]>,
  llmHealthPenalty = 0.1,
  rules: TranslationRule[] = [],
  penalties: RulePenalties = { major: 15, minor: 5 }
): HealthStats {
  const multiplier = 1 - llmHealthPenalty
  return useMemo(
    () => computeHealthMap(fileCells, multiplier, rules, penalties),
    [fileCells, multiplier, rules, penalties]
  )
}

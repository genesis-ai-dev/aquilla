import { useMemo } from "react"
import { computeHealthMap, type HealthStats } from "@/lib/health/health-engine"
import { useCompositeHealth } from "./useCompositeHealth"
import type { CellData } from "./useCells"
import type { TranslationRule, RulePenalties, HealthConfig, CellHealthBreakdown } from "@/lib/parsers/types"
import { HEALTH_DEFAULTS } from "@/lib/health/defaults"

interface HealthDispatchOptions {
  composite: boolean
  compositeConfig?: HealthConfig
  requiredValidations?: number
}

export function useHealth(
  fileCells: Map<string, CellData[]>,
  llmHealthPenalty = 0.1,
  rules: TranslationRule[] = [],
  penalties: RulePenalties = { major: 15, minor: 5 },
  options: HealthDispatchOptions = { composite: false },
): HealthStats {
  const multiplier = 1 - llmHealthPenalty

  // Legacy result — always computed (cheap), used when flag is off
  const legacy = useMemo(
    () => computeHealthMap(fileCells, multiplier, rules, penalties),
    [fileCells, multiplier, rules, penalties],
  )

  // Composite — only meaningful when flag on, but the hook must run unconditionally (Rules of Hooks)
  const composite = useCompositeHealth({
    fileCells: options.composite ? fileCells : new Map(),
    rules,
    config: options.compositeConfig ?? HEALTH_DEFAULTS,
    requiredValidations: options.requiredValidations ?? 1,
  })

  if (!options.composite) return legacy

  const breakdownMap: Map<string, CellHealthBreakdown> = composite.stats.breakdownMap
  return {
    healthMap: composite.stats.healthMap,
    fileHealth: composite.stats.fileHealth,
    projectHealth: composite.stats.projectHealth,
    fileProgress: legacy.fileProgress,
    infractions: composite.stats.infractions,
    openCommentCount: legacy.openCommentCount,
    projectOpenCommentCount: legacy.projectOpenCommentCount,
    cellOpenCommentCount: legacy.cellOpenCommentCount,
    breakdownMap,
  }
}

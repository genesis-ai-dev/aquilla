import { useMemo } from "react"
import { computeHealthMap, type HealthStats } from "@/lib/health/health-engine"
import type { CellData } from "./useCells"

export function useHealth(
  fileCells: Map<string, CellData[]>,
  llmHealthPenalty = 0.1
): HealthStats {
  const multiplier = 1 - llmHealthPenalty
  return useMemo(() => computeHealthMap(fileCells, multiplier), [fileCells, multiplier])
}

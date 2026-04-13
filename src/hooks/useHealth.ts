import { useMemo } from "react"
import { computeHealthMap, type HealthStats } from "@/lib/health/health-engine"
import type { CellData } from "./useCells"

export function useHealth(
  fileCells: Map<string, CellData[]>
): HealthStats {
  return useMemo(() => computeHealthMap(fileCells), [fileCells])
}

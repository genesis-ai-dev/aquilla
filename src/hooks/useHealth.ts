import { useMemo, useRef } from "react"
import { computeHealthMap, type HealthStats } from "@/lib/health/health-engine"
import { useCompositeHealth } from "./useCompositeHealth"
import type { CellData } from "./useCells"
import type { TranslationRule, RulePenalties, HealthConfig, CellHealthBreakdown, RuleInfraction } from "@/lib/parsers/types"
import { HEALTH_DEFAULTS } from "@/lib/health/defaults"
import { perfMark } from "@/lib/perf-log"

interface HealthDispatchOptions {
  composite: boolean
  compositeConfig?: HealthConfig
  requiredValidations?: number
}

// ---------------------------------------------------------------------------
// Structural-stability helpers. Every `computeHealthMap` call returns fresh
// Map references even when per-cell values didn't change — typing in cell X
// leaves every other cell's health/infractions/comment-count identical, but
// the wrapping Map object is new, which defeats React.memo on every
// downstream row. These helpers detect "contents unchanged" and let us reuse
// the previous ref so memo holds.
//
// O(n) cost per call where n is the number of entries; a typing keystroke
// that changes nothing rule-relevant finishes all iterations once (~5ms on
// a 30k-cell Bible) in exchange for skipping N×render re-evaluations of
// every visible row.
// ---------------------------------------------------------------------------

function primitiveMapsEqual<V>(a: Map<string, V>, b: Map<string, V>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false
  }
  return true
}

function infractionMapsEqual(
  a: Map<string, RuleInfraction[]>,
  b: Map<string, RuleInfraction[]>,
): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [k, av] of a) {
    const bv = b.get(k)
    if (!bv) return false
    if (av.length !== bv.length) return false
    for (let i = 0; i < av.length; i++) {
      // Compare by ruleId + message — enough to detect rule-trigger changes
      // without a full deep equality over the object.
      if (av[i].ruleId !== bv[i].ruleId) return false
      if (av[i].message !== bv[i].message) return false
    }
  }
  return true
}

function progressMapsEqual(
  a: Map<string, { translated: number; validated: number; total: number }>,
  b: Map<string, { translated: number; validated: number; total: number }>,
): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [k, av] of a) {
    const bv = b.get(k)
    if (!bv) return false
    if (av.translated !== bv.translated || av.validated !== bv.validated || av.total !== bv.total) return false
  }
  return true
}

function breakdownMapsEqual(
  a: Map<string, CellHealthBreakdown>,
  b: Map<string, CellHealthBreakdown>,
): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [k, av] of a) {
    const bv = b.get(k)
    if (!bv) return false
    if (av.score !== bv.score) return false
    if (av.validationGap !== bv.validationGap) return false
    if (av.ancestryPenalty !== bv.ancestryPenalty) return false
    if (av.neighborhoodPenalty !== bv.neighborhoodPenalty) return false
    if (av.rulePenalty !== bv.rulePenalty) return false
  }
  return true
}

function healthStatsEqual(a: HealthStats, b: HealthStats): boolean {
  if (a === b) return true
  if (a.projectHealth !== b.projectHealth) return false
  if (a.projectOpenCommentCount !== b.projectOpenCommentCount) return false
  if (!primitiveMapsEqual(a.healthMap, b.healthMap)) return false
  if (!primitiveMapsEqual(a.fileHealth, b.fileHealth)) return false
  if (!primitiveMapsEqual(a.openCommentCount, b.openCommentCount)) return false
  if (!primitiveMapsEqual(a.cellOpenCommentCount, b.cellOpenCommentCount)) return false
  if (!progressMapsEqual(a.fileProgress, b.fileProgress)) return false
  if (!infractionMapsEqual(a.infractions, b.infractions)) return false
  if (!breakdownMapsEqual(a.breakdownMap, b.breakdownMap)) return false
  return true
}

// Single shared empty result used as the legacy stand-in when composite is on.
// Stable reference so the composite-mode useMemo below doesn't re-trigger.
const EMPTY_HEALTH_STATS: HealthStats = {
  healthMap: new Map(),
  fileHealth: new Map(),
  projectHealth: 0,
  fileProgress: new Map(),
  infractions: new Map(),
  openCommentCount: new Map(),
  projectOpenCommentCount: 0,
  cellOpenCommentCount: new Map(),
  breakdownMap: new Map(),
}

// Composite-on path still needs file progress + comment counts (the composite
// engine doesn't compute those). Cheap auxiliary derivation, O(N) but only the
// counting bits — no rule checks, no LLM-chain scoring.
function deriveAuxStats(fileCells: Map<string, CellData[]>): {
  fileProgress: HealthStats["fileProgress"]
  openCommentCount: HealthStats["openCommentCount"]
  projectOpenCommentCount: HealthStats["projectOpenCommentCount"]
  cellOpenCommentCount: HealthStats["cellOpenCommentCount"]
} {
  const fileProgress: HealthStats["fileProgress"] = new Map()
  const openCommentCount: HealthStats["openCommentCount"] = new Map()
  const cellOpenCommentCount: HealthStats["cellOpenCommentCount"] = new Map()
  let projectOpenCommentCount = 0
  for (const [fileId, cells] of fileCells) {
    let translated = 0
    let validated = 0
    let fileOpen = 0
    for (const cell of cells) {
      if (cell.status !== "empty") translated++
      if (cell.status === "validated") validated++
      const threads = cell.threads ?? []
      let openForCell = 0
      for (const t of threads) if (t.status === "open") openForCell++
      if (openForCell > 0) {
        cellOpenCommentCount.set(cell.id, openForCell)
        fileOpen += openForCell
      }
    }
    fileProgress.set(fileId, { translated, validated, total: cells.length })
    openCommentCount.set(fileId, fileOpen)
    projectOpenCommentCount += fileOpen
  }
  return { fileProgress, openCommentCount, projectOpenCommentCount, cellOpenCommentCount }
}

export function useHealth(
  fileCells: Map<string, CellData[]>,
  llmHealthPenalty = 0.1,
  rules: TranslationRule[] = [],
  penalties: RulePenalties = { major: 15, minor: 5 },
  options: HealthDispatchOptions = { composite: false },
): HealthStats {
  const multiplier = 1 - llmHealthPenalty

  // Legacy result — only computed when the legacy path will actually be used
  // (composite flag off). Skipping this when composite is on saves a full
  // O(N) sweep + checkRules over every cell on every keystroke.
  const legacyRaw = useMemo(() => {
    if (options.composite) return EMPTY_HEALTH_STATS
    const end = perfMark("useHealth.legacy.computeHealthMap")
    const r = computeHealthMap(fileCells, multiplier, rules, penalties)
    end()
    return r
  }, [options.composite, fileCells, multiplier, rules, penalties])

  // Composite — only meaningful when flag on, but the hook must run unconditionally (Rules of Hooks)
  const composite = useCompositeHealth({
    fileCells: options.composite ? fileCells : new Map(),
    rules,
    config: options.compositeConfig ?? HEALTH_DEFAULTS,
    requiredValidations: options.requiredValidations ?? 1,
  })

  // Auxiliary stats that the composite worker doesn't produce (file progress,
  // comment counts). Only needed in composite mode; legacy result already
  // contains these.
  const aux = useMemo(() => {
    if (!options.composite) return null
    return deriveAuxStats(fileCells)
  }, [options.composite, fileCells])

  // Assemble the raw result that will be returned to callers.
  const raw: HealthStats = useMemo(() => {
    if (!options.composite) return legacyRaw
    const breakdownMap: Map<string, CellHealthBreakdown> = composite.stats.breakdownMap
    return {
      healthMap: composite.stats.healthMap,
      fileHealth: composite.stats.fileHealth,
      projectHealth: composite.stats.projectHealth,
      fileProgress: aux?.fileProgress ?? new Map(),
      infractions: composite.stats.infractions,
      openCommentCount: aux?.openCommentCount ?? new Map(),
      projectOpenCommentCount: aux?.projectOpenCommentCount ?? 0,
      cellOpenCommentCount: aux?.cellOpenCommentCount ?? new Map(),
      breakdownMap,
    }
  }, [options.composite, legacyRaw, composite.stats, aux])

  // Structural stability: if the raw result is semantically unchanged from
  // last render, return the previous reference so React.memo on downstream
  // consumers (every row in the virtualizer) can hold. A no-rule keystroke
  // finishes the equality walk in a few ms and saves a full re-render of
  // every visible row.
  const prevRef = useRef<HealthStats | null>(null)
  if (prevRef.current && healthStatsEqual(prevRef.current, raw)) {
    return prevRef.current
  }
  prevRef.current = raw
  return raw
}

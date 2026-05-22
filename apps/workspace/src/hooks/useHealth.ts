import { useMemo, useRef } from "react"
import type { HealthStats } from "@/lib/health/health-engine"
import { computeDecayHealth, DECAY_DEFAULTS } from "@/lib/health/decay-engine"
import { checkRules } from "@/lib/rules/rule-engine"
import type { CellData } from "./useCells"
import type { TranslationRule, HealthConfig, CellHealthBreakdown, RuleInfraction, DecaySettings } from "@/lib/parsers/types"
import { perfMark } from "@/lib/perf-log"
import type { CellAuditStats } from "./useCellsAuditStats"

interface HealthDispatchOptions {
  /** AD-14 decay tunables (endorsementTarget, decayWarnThreshold). */
  decaySettings?: DecaySettings
  /** @deprecated four-sub-score flag — ignored since AD-14 (decay). */
  composite?: boolean
  /** @deprecated four-sub-score config — ignored since AD-14. */
  compositeConfig?: HealthConfig
  requiredValidations?: number
  /** @deprecated audit stats fed the composite worker — no longer used. */
  auditStats?: Map<string, CellAuditStats>
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

// Four-sub-score breakdown is retired by AD-14 — the breakdown popover
// self-hides when this map is empty (StatusBar passes undefined). Stable
// shared reference so the assembled result stays referentially stable.
const EMPTY_BREAKDOWN: Map<string, CellHealthBreakdown> = new Map()

// Health derives from decay (endorsement_count). File progress + comment
// counts are a cheap O(N) auxiliary derivation — no rule checks, no scoring.
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
  rules: TranslationRule[] = [],
  options: HealthDispatchOptions = {},
): HealthStats {
  const decaySettingsKey = JSON.stringify(options.decaySettings ?? null)

  // AD-14: health (project / file / per-cell) derives from decay, computed
  // purely from each cell's endorsement_count.
  const decay = useMemo(() => {
    const end = perfMark("useHealth.computeDecayHealth")
    const settings = {
      endorsementTarget: options.decaySettings?.endorsementTarget ?? DECAY_DEFAULTS.endorsementTarget,
      decayWarnThreshold: options.decaySettings?.decayWarnThreshold ?? DECAY_DEFAULTS.decayWarnThreshold,
    }
    const r = computeDecayHealth(fileCells, settings)
    end()
    return r
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileCells, decaySettingsKey])

  // Rule / built-in-check violations — a SEPARATE sibling surface (AD-14), not
  // folded into health. Same standalone pass the legacy engine used.
  const infractions = useMemo(() => {
    const end = perfMark("useHealth.checkRules")
    const r = checkRules(fileCells, rules)
    end()
    return r
  }, [fileCells, rules])

  // File progress + open-comment counts.
  const aux = useMemo(() => deriveAuxStats(fileCells), [fileCells])

  // Assemble the raw result that will be returned to callers.
  const raw: HealthStats = useMemo(
    () => ({
      healthMap: decay.healthMap,
      fileHealth: decay.fileHealth,
      projectHealth: decay.projectHealth,
      fileProgress: aux.fileProgress,
      infractions,
      openCommentCount: aux.openCommentCount,
      projectOpenCommentCount: aux.projectOpenCommentCount,
      cellOpenCommentCount: aux.cellOpenCommentCount,
      breakdownMap: EMPTY_BREAKDOWN,
    }),
    [decay, infractions, aux],
  )

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

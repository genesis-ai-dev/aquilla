import { useMemo, useRef } from "react"
import { computeDecayHealth, resolveDecayConfig, type HealthStats } from "@/lib/health/decay-engine"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import type { CellData } from "./useCells"
import type { TranslationRule, RuleInfraction, DecaySettings } from "@/lib/parsers/types"
import { perfMark, memMark } from "@/lib/perf-log"

export interface HealthCell {
  id: string
  status: CellData["status"]
  original: string
  translated: string
  endorsementCount?: number
  threads?: CellData["threads"]
}

interface HealthDispatchOptions {
  /**
   * AD-14 decay tunables. endorsementTarget is deprecated (superseded by
   * server confidence rollup); decayWarnThreshold and maxHops remain active.
   */
  decaySettings?: DecaySettings
  requiredValidations?: number
  /**
   * AD-14 amendment 2026-06-04: server-derived confidence rollup. When
   * supplied, overrides the endorsement-count decay path for health numbers.
   * Per-cell health is still derived locally (confidence per cell from the
   * server-side route via useCellConfidence); this override applies to file
   * and project-level aggregates only, making those numbers authoritative and
   * consistent with the rollup the server computed.
   *
   * Falls back to null → uses endorsement_count path (local-only projects or
   * when the server rollup hasn't loaded yet).
   */
  serverRollup?: {
    projectHealth: number | null
    fileHealth: Map<string, number>
  } | null
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
  return true
}

// Health derives from decay (endorsement_count). File progress + comment
// counts are a cheap O(N) auxiliary derivation — no rule checks, no scoring.
//
// AQU-280 (audit F-P2): deriveAuxStats counts `cell.status === "validated"` for
// the validated tally. `cell.status` is derived in useCells.buildCellData from
// the server-projected `target.validated` flag (via deriveStatus → validatedForStatus),
// which AQU-279 made threshold-aware. This function therefore already consumes
// the authoritative server flag — no client-side threshold re-derivation here.
function deriveAuxStats(fileCells: Map<string, readonly HealthCell[]>): {
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
  fileCells: Map<string, readonly HealthCell[]>,
  rules: TranslationRule[] = [],
  options: HealthDispatchOptions = {},
): HealthStats {
  const requiredValidations = options.requiredValidations ?? 1
  const decaySettingsKey = JSON.stringify(options.decaySettings ?? null) + `|${requiredValidations}`

  // AD-14: health (project / file / per-cell) derives from decay, computed
  // purely from each cell's endorsement_count. The endorsement target defaults
  // to the project's required-validations gate (see resolveDecayConfig) so a
  // validated cell reaches full health.
  const decay = useMemo(() => {
    const end = perfMark("useHealth.computeDecayHealth")
    const settings = resolveDecayConfig(options.decaySettings, requiredValidations)
    const r = computeDecayHealth(fileCells, settings)
    end()
    memMark("useHealth.decay")
    return r
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileCells, decaySettingsKey])

  // Rule / built-in-check violations — a SEPARATE sibling surface (AD-14), not
  // folded into health. Incremental: every commit revalidates the cells array
  // and rebuilds `fileCells` to a new Map ref, so a naive full pass re-evaluates
  // every cell for every keystroke-blur (8+s on a Bible book). Rules are pure
  // per-cell (see rule-engine.ts), so we cache infractions keyed on each cell's
  // content signature and only re-run `checkRulesForCell` for cells whose
  // (status, original, translated) actually changed.
  const infractionsCacheRef = useRef<{
    rulesSig: string
    byCell: Map<string, { sig: string; infractions: RuleInfraction[] }>
  }>({ rulesSig: "", byCell: new Map() })

  // `enabledRules` + `rulesSig` depend only on `rules`, which changes far less
  // often than `fileCells` (every keystroke rebuilds the cells map). Hoisting
  // them here keeps the JSON.stringify over potentially hundreds of terminology
  // rules off the per-keystroke path — the infractions memo below re-runs on
  // every edit, but now reuses these stable values instead of re-serializing.
  const { enabledRules, rulesSig } = useMemo(() => {
    const enabled = rules.filter((r) => r.enabled)
    return {
      enabledRules: enabled,
      rulesSig: JSON.stringify(enabled.map((r) => [r.id, r.name, r.check])),
    }
  }, [rules])

  const infractions = useMemo(() => {
    const end = perfMark("useHealth.checkRules")
    const cache = infractionsCacheRef.current
    const rulesChanged = cache.rulesSig !== rulesSig

    const nextByCell = new Map<string, { sig: string; infractions: RuleInfraction[] }>()
    const result = new Map<string, RuleInfraction[]>()

    if (enabledRules.length === 0) {
      infractionsCacheRef.current = { rulesSig, byCell: nextByCell }
      end()
      return result
    }

    for (const [fileId, cells] of fileCells) {
      for (const cell of cells) {
        const sig = `${cell.status} ${cell.original} ${cell.translated}`
        const prev = rulesChanged ? undefined : cache.byCell.get(cell.id)
        const entry = prev && prev.sig === sig
          ? prev
          : { sig, infractions: checkRulesForCell(cell as CellData, fileId, enabledRules) }
        nextByCell.set(cell.id, entry)
        if (entry.infractions.length > 0) result.set(cell.id, entry.infractions)
      }
    }

    infractionsCacheRef.current = { rulesSig, byCell: nextByCell }
    end()
    memMark("useHealth.checkRules")
    return result
  }, [fileCells, enabledRules, rulesSig])

  // File progress + open-comment counts.
  const aux = useMemo(() => deriveAuxStats(fileCells), [fileCells])

  // AD-14 amendment: prefer server-derived confidence rollup for file/project
  // aggregates when available. Per-cell healthMap stays from the local decay
  // path (endorsed or confidence-overlay via useCellConfidence — the server
  // rollup route returns aggregates, not per-cell values).
  const serverRollup = options.serverRollup ?? null
  const effectiveProjectHealth =
    serverRollup?.projectHealth != null ? serverRollup.projectHealth : decay.projectHealth
  const effectiveFileHealth =
    serverRollup && serverRollup.fileHealth.size > 0 ? serverRollup.fileHealth : decay.fileHealth

  // Assemble the raw result that will be returned to callers.
  const raw: HealthStats = useMemo(
    () => ({
      healthMap: decay.healthMap,
      fileHealth: effectiveFileHealth,
      projectHealth: effectiveProjectHealth,
      fileProgress: aux.fileProgress,
      infractions,
      openCommentCount: aux.openCommentCount,
      projectOpenCommentCount: aux.projectOpenCommentCount,
      cellOpenCommentCount: aux.cellOpenCommentCount,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [decay, infractions, aux, effectiveProjectHealth, effectiveFileHealth],
  )

  // Structural stability: if the raw result is semantically unchanged from
  // last render, return the previous reference so React.memo on downstream
  // consumers (every row in the virtualized list) can hold. A no-rule keystroke
  // finishes the equality walk in a few ms and saves a full re-render of
  // every visible row.
  const prevRef = useRef<HealthStats | null>(null)
  if (prevRef.current && healthStatsEqual(prevRef.current, raw)) {
    return prevRef.current
  }
  prevRef.current = raw
  return raw
}

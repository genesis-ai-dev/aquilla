import type {
  HealthConfig, TranslationRule, RuleInfraction, CellHealthBreakdown, CellHistoryEntry,
} from "@/lib/parsers/types"
import { DualIndex } from "@/lib/search/dual-index"
import { computeOneCellHealth, type CompositeCell } from "@/lib/health/composite/compute"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
// NOTE: this module runs in BOTH the main thread (sync fallback / tests) and
// the dedicated Worker. Workers have their own localStorage, so the
// localStorage-gated perf-log helper is unreliable here. We use a local flag
// that the caller flips via `setHealthSyncPerf(true)` whenever the main-thread
// `PERF_LOG` is on; that way worker logs (visible in DevTools) actually fire.
let perfOn = false
let perfBuffer: string[] = []
export function setHealthSyncPerf(on: boolean): void { perfOn = on }
/** Drain and return any perf messages logged since the last call. The worker
 *  ships these back to the main thread so they appear in DevTools (worker
 *  console.log isn't visible to MCP-style log consumers). */
export function consumeHealthSyncPerfBuffer(): string[] {
  if (perfBuffer.length === 0) return []
  const out = perfBuffer
  perfBuffer = []
  return out
}
function plog(label: string, ...args: unknown[]): void {
  if (!perfOn) return
  const suffix = args.length > 0 ? " " + args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ") : ""
  perfBuffer.push(`[perf] ${label}${suffix}`)
}
function pmark(label: string): () => number {
  if (!perfOn) return () => 0
  const t = performance.now()
  return () => {
    const dt = performance.now() - t
    perfBuffer.push(`[perf] ${label} ${dt.toFixed(2)}ms`)
    return dt
  }
}

export interface HealthSyncCell {
  id: string
  fileId: string
  original: string
  translated: string
  validatorCount: number
  history: CellHistoryEntry[]
}

export interface HealthSyncRequest {
  cells: HealthSyncCell[]
  rules: TranslationRule[]
  config: HealthConfig
  requiredValidations: number
}

export interface HealthSyncResponse {
  healthMap: Map<string, number>
  breakdownMap: Map<string, CellHealthBreakdown>
  fileHealth: Map<string, number>
  projectHealth: number
  infractions: Map<string, RuleInfraction[]>
}

// ---------------------------------------------------------------------------
// Persistent incremental state. The "spreadsheet model": each cell's health
// is what it was last computed to be. When cell X's Yjs content changes:
//   1) X's entry in the DualIndex is updated (one cell's tokens)
//   2) X's infractions are re-checked (rules are pure per-cell)
//   3) X's composite + health is recomputed, reading peer healths from cache
//   4) Per-file and project aggregates are adjusted by the delta X → X'
//
// No other cell recomputes. Cells whose neighborhood formally depends on X
// keep their cached score — a conscious trade of minor staleness for no
// ripples. When those cells are themselves next edited, they pick up X's
// new state. An explicit full-resweep is available via resetHealthSyncCache.
//
// The rule/config refs are snapshotted: any change to them triggers a full
// invalidation, since rule penalties and config caps touch every cell.
// ---------------------------------------------------------------------------

let cachedIndex: DualIndex | null = null
const prevCellSig = new Map<string, string>()
const cellFileId = new Map<string, string>()
const cachedHealth = new Map<string, number>()
const cachedBreakdown = new Map<string, CellHealthBreakdown>()
const cachedInfractions = new Map<string, RuleInfraction[]>()
const fileStats = new Map<string, { sum: number; count: number }>()
let globalSum = 0
let globalCount = 0

// Rules/config invalidation tracking — reference equality by default; if
// callers pass fresh array/object refs per call, the full-rebuild path
// triggers (which is safe, just slower — same as the pre-incremental
// baseline). Production callers (useCompositeHealth) keep these stable.
let prevRulesRef: TranslationRule[] | null = null
let prevConfigRef: HealthConfig | null = null
let prevRequiredValidations = -1
let prevRulesContent = ""

function cellSig(c: HealthSyncCell): string {
  return `${c.fileId}\u0001${c.validatorCount}\u0001${c.original}\u0001${c.translated}\u0001${c.history.length}\u0001${c.history.at(-1)?.examples?.map(e => typeof e === "string" ? e : `${e.cellId}:${e.weight}`).join(",") ?? ""}`
}

/** Rebuild from scratch. Called on rules/config change and exposed for tests. */
export function resetHealthSyncCache(): void {
  cachedIndex = null
  prevCellSig.clear()
  cellFileId.clear()
  cachedHealth.clear()
  cachedBreakdown.clear()
  cachedInfractions.clear()
  fileStats.clear()
  globalSum = 0
  globalCount = 0
  prevRulesRef = null
  prevConfigRef = null
  prevRequiredValidations = -1
  prevRulesContent = ""
}

function purgeCell(cellId: string): void {
  const oldScore = cachedHealth.get(cellId)
  const fid = cellFileId.get(cellId)
  if (oldScore !== undefined && fid) {
    const fs = fileStats.get(fid)
    if (fs) {
      fs.sum -= oldScore
      fs.count -= 1
      if (fs.count <= 0) fileStats.delete(fid)
    }
    globalSum -= oldScore
    globalCount -= 1
  }
  cachedHealth.delete(cellId)
  cachedBreakdown.delete(cellId)
  cachedInfractions.delete(cellId)
  cellFileId.delete(cellId)
}

function recordHealth(cellId: string, fileId: string, newScore: number): void {
  const oldScore = cachedHealth.get(cellId)
  if (oldScore !== undefined) {
    const fs = fileStats.get(fileId)
    if (fs) {
      fs.sum += (newScore - oldScore)
    } else {
      fileStats.set(fileId, { sum: newScore, count: 1 })
    }
    globalSum += (newScore - oldScore)
  } else {
    let fs = fileStats.get(fileId)
    if (!fs) { fs = { sum: 0, count: 0 }; fileStats.set(fileId, fs) }
    fs.sum += newScore
    fs.count += 1
    globalSum += newScore
    globalCount += 1
  }
  cachedHealth.set(cellId, newScore)
  cellFileId.set(cellId, fileId)
}

function rulesContentKey(rules: TranslationRule[]): string {
  // Cheap structural key so we detect rule body changes even when the array
  // is passed by a caller that reuses a ref but mutates it. Enabled set +
  // the per-rule check payload is what actually drives infractions.
  const parts: string[] = []
  for (const r of rules) {
    parts.push(`${r.id}:${r.enabled ? 1 : 0}:${r.severity}:${JSON.stringify(r.check)}`)
  }
  return parts.join("|")
}

export function computeHealthSync(req: HealthSyncRequest): HealthSyncResponse {
  const endTotal = pmark("health.compute total")

  // Full invalidation when the rule/config landscape shifts. Every cell's
  // score depends on these, so incremental per-cell work wouldn't be sound.
  const rulesChanged = req.rules !== prevRulesRef || rulesContentKey(req.rules) !== prevRulesContent
  const configChanged = req.config !== prevConfigRef
  const requiredChanged = req.requiredValidations !== prevRequiredValidations
  if (rulesChanged || configChanged || requiredChanged) {
    plog(`health.compute full-invalidate rules=${rulesChanged} config=${configChanged} required=${requiredChanged}`)
    resetHealthSyncCache()
    prevRulesRef = req.rules
    prevRulesContent = rulesContentKey(req.rules)
    prevConfigRef = req.config
    prevRequiredValidations = req.requiredValidations
  }

  if (!cachedIndex) cachedIndex = new DualIndex()
  const index = cachedIndex
  const enabledRules = req.rules.filter((r) => r.enabled)

  // --- Phase 1: diff input against prev signatures; update index incrementally.
  const endIndex = pmark("health.compute indexUpdate")
  const currentIds = new Set<string>()
  const changedIds: string[] = []
  for (const c of req.cells) {
    currentIds.add(c.id)
    const sig = cellSig(c)
    if (prevCellSig.get(c.id) === sig) continue
    prevCellSig.set(c.id, sig)
    index.removePair(c.id)
    if (c.original.trim() && c.translated.trim()) {
      index.addPair({ id: c.id, original: c.original, translated: c.translated, fileId: c.fileId })
    }
    changedIds.push(c.id)
  }

  // --- Phase 2: drop cells no longer in the corpus.
  let removedCount = 0
  for (const id of [...prevCellSig.keys()]) {
    if (currentIds.has(id)) continue
    index.removePair(id)
    prevCellSig.delete(id)
    purgeCell(id)
    removedCount++
  }
  endIndex()

  // --- Phase 3: recompute only the changed cells. Everyone else keeps their
  // cached score — no ripples. Aggregates adjust via delta.
  let ruleCheckMs = 0
  let neighborhoodMs = 0
  let healthCalcMs = 0
  if (changedIds.length > 0) {
    const cellById = new Map<string, HealthSyncCell>()
    for (const c of req.cells) cellById.set(c.id, c)

    for (const id of changedIds) {
      const cell = cellById.get(id)
      if (!cell) continue

      // A cell that just became empty shouldn't contribute to health at all.
      if (!cell.translated.trim()) {
        purgeCell(id)
        continue
      }

      // Rule check — pure per-cell, no dependency on peers.
      const ruleAdapted = adaptToRuleEngineCell(cell)
      const t0 = perfOn ? performance.now() : 0
      const inf = checkRulesForCell(ruleAdapted, cell.fileId, enabledRules)
      if (perfOn) ruleCheckMs += performance.now() - t0
      if (inf.length > 0) cachedInfractions.set(id, inf)
      else cachedInfractions.delete(id)

      // Build composite (neighborhood queries use the current incremental index).
      const last = cell.history[cell.history.length - 1]
      const t1 = perfOn ? performance.now() : 0
      const composite: CompositeCell = {
        id: cell.id,
        fileId: cell.fileId,
        translated: cell.translated,
        validatorCount: cell.validatorCount,
        examples: last?.examples,
        infractions: inf,
        branchingSource: index.searchBranchingSource(cell.original, req.config.neighborhoodSearchLimit),
        branchingTarget: index.searchBranchingTarget(cell.translated, req.config.neighborhoodSearchLimit),
        plainSource: index.searchPlainSource(cell.original, req.config.neighborhoodSearchLimit),
        plainTarget: index.searchPlainTarget(cell.translated, req.config.neighborhoodSearchLimit),
      }
      if (perfOn) neighborhoodMs += performance.now() - t1

      // Compute using cached peer healths. Ancestry misses fall back to 0
      // (ancestryPenalty treats unknowns as lowest health), which matches
      // the pre-incremental behavior on a fresh healthMap.
      const t2 = perfOn ? performance.now() : 0
      const { score, breakdown } = computeOneCellHealth(
        composite, req.rules, req.config, req.requiredValidations, cachedHealth,
      )
      if (perfOn) healthCalcMs += performance.now() - t2
      recordHealth(id, cell.fileId, score)
      cachedBreakdown.set(id, breakdown)
    }
  }

  plog(
    `health.compute incoming=${req.cells.length} changed=${changedIds.length} removed=${removedCount} ` +
    `cached=${cachedHealth.size} indexSize=${index.size()} ` +
    `rule=${ruleCheckMs.toFixed(2)}ms neighborhood=${neighborhoodMs.toFixed(2)}ms health=${healthCalcMs.toFixed(2)}ms`
  )

  // --- Phase 4: assemble aggregates from running totals.
  const fileHealth = new Map<string, number>()
  for (const [fid, stats] of fileStats) {
    fileHealth.set(fid, stats.count > 0 ? Math.round(stats.sum / stats.count) : 0)
  }
  const projectHealth = globalCount > 0 ? Math.round(globalSum / globalCount) : 0

  // Return fresh Map copies so callers that treat the response as immutable
  // don't see subsequent mutations. Cheap: O(cached cells), but this is a
  // once-per-debounce cost, not per-keystroke.
  const out = {
    healthMap: new Map(cachedHealth),
    breakdownMap: new Map(cachedBreakdown),
    fileHealth,
    projectHealth,
    infractions: new Map(cachedInfractions),
  }
  endTotal()
  return out
}

function adaptToRuleEngineCell(c: HealthSyncCell) {
  // checkRulesForCell only reads a few fields off CellData. We provide the
  // minimum: id, original, translated, status, plus the empty shape fields
  // the type requires.
  return {
    id: c.id,
    original: c.original,
    originalHtml: "",
    translated: c.translated,
    context: "",
    group: "",
    type: "text" as const,
    status: (c.translated.trim() ? "unvalidated" : "empty") as "unvalidated" | "empty",
    validationStatus: "none" as const,
    activeValidators: [] as string[],
    validationHistory: [],
    history: c.history,
    threads: [],
    fileId: c.fileId,
  }
}

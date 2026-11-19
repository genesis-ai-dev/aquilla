import { useEffect, useMemo, useRef, useState } from "react"
import { computeDecayHealth, resolveDecayConfig, type HealthStats } from "@/lib/health/decay-engine"
import { checkRulesForCell, type CellCheckContext } from "@/lib/rules/rule-engine"
import type { CellData } from "./useCells"
import type { TranslationRule, RuleInfraction, DecaySettings } from "@/lib/parsers/types"
import { perfMark, memMark } from "@/lib/perf-log"
import { conceptPatternsCompiled } from "@/lib/terminology/match"
import { scheduleSlice } from "./useProjectInfractions"

/**
 * How many glossary-term regexes one synchronous rule pass may compile for the
 * first time before the rest of the file is checked in the background
 * (AQU-2654).
 *
 * Checking a cell is cheap once its patterns are compiled; compiling one is
 * not — a glossary term with mark folding and affixes costs V8 around 8 ms at
 * 1x CPU. A file that mentions a couple of hundred glossary terms would hold
 * the main thread for seconds the first time it is opened, inside render.
 * The budget counts the expensive thing itself, so it does not depend on the
 * machine: a pass that stays under it (every edit, and a file that mentions
 * up to a few dozen terms not seen before) is synchronous exactly as before.
 */
const SYNC_PATTERN_BUDGET = 32

/** Milliseconds of background checking per idle slice. */
const BACKGROUND_SLICE_MS = 8

/** A partial infractions map → how many cells it is still waiting for. */
const pendingCounts = new WeakMap<Map<string, RuleInfraction[]>, number>()

export interface HealthCell {
  id: string
  status: CellData["status"]
  original: string
  translated: string
  medium?: CellData["medium"]
  transcription?: string
  hasOwnTake?: boolean
  /** Media redesign slice 2: the line's progress status by what its language
   *  delivers; absent in a Text language, where progress reads `status`. */
  laneStatus?: CellData["laneStatus"]
  endorsementCount?: number
  threads?: CellData["threads"]
}

interface RuleCacheEntry {
  fileId: string
  status: HealthCell["status"]
  original: string
  translated: string
  medium: HealthCell["medium"]
  transcription: string | undefined
  hasOwnTake: boolean | undefined
  infractions: RuleInfraction[]
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
  /**
   * Kill switch (see `@/lib/health/kill-switch`). When false, decay health
   * and rule checks are skipped entirely: healthMap/infractions come back
   * empty and no per-cell caches are retained. File progress and comment
   * counts (cheap, non-health) are still derived.
   */
  enabled?: boolean
  /**
   * AQU-934 phase 3a: per-cell lint rule set. Returns the rules to check this
   * cell with — `enabledRules` plus whichever style-library checks the
   * applicability graph puts in force for that cell (see
   * `buildLibraryLintResolver`). Returning `enabledRules` unchanged is the
   * no-op, and is what the composer does by reference when nothing applies.
   *
   * Called ONLY on an infraction-cache miss: resolution must never ride the
   * keystroke path (see the cache rationale below).
   */
  rulesForCell?: (
    cell: HealthCell,
    fileId: string,
    enabledRules: TranslationRule[],
  ) => TranslationRule[]
  /**
   * Changes iff the style-rule library or its applicability graph changed.
   * Folded into `rulesSig`, so a library edit re-lints every cached cell.
   * `NO_LIBRARY_LINT_SIGNATURE` ("") is the composer's marker for "no library
   * rule can lint anything".
   */
  rulesForCellSig?: string
  /**
   * AQU-1688: a cell's extra check inputs (its compiled Bible data
   * expectation and the Language profile), looked up by the cell's own id.
   * Called ONLY on an infraction-cache miss, like `rulesForCell`, and it must
   * describe that cell alone, never read another cell's text.
   */
  cellCheckContext?: (cell: HealthCell, fileId: string) => CellCheckContext | undefined
  /**
   * Changes iff anything `cellCheckContext` returns could change (pack
   * version, compiled refs, Language profile). Folded into `rulesSig`.
   */
  cellCheckContextSig?: string
}

const EMPTY_HEALTH_MAP: Map<string, number> = new Map()
const EMPTY_INFRACTIONS: Map<string, RuleInfraction[]> = new Map()
const DISABLED_DECAY = { healthMap: EMPTY_HEALTH_MAP, fileHealth: EMPTY_HEALTH_MAP, projectHealth: 0 }

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
      const left = av[i]
      const right = bv[i]
      if (left === right) continue
      if (left.ruleId !== right.ruleId || left.reason !== right.reason
        || left.cellId !== right.cellId || left.fileId !== right.fileId) return false
      const keys = Object.keys(left.reasonParams ?? {})
      if (keys.length !== Object.keys(right.reasonParams ?? {}).length
        || keys.some(key => left.reasonParams?.[key] !== right.reasonParams?.[key])) return false
      if (left.spans.length !== right.spans.length) return false
      for (let index = 0; index < left.spans.length; index++) {
        const a = left.spans[index]
        const b = right.spans[index]
        if (a.side !== b.side || a.start !== b.start || a.end !== b.end || a.matchedText !== b.matchedText) return false
      }
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
  if ((a.infractionsPending ?? 0) !== (b.infractionsPending ?? 0)) return false
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
      // Media redesign slice 2: a language that counts its recordings counts
      // a line by `laneStatus` (recorded / approved for Audio); a Text
      // language has none and counts its text, exactly as before.
      const progress = cell.laneStatus ?? cell.status
      if (progress !== "empty") translated++
      if (progress === "validated") validated++
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

/** Save acknowledgements change event IDs and timestamps without changing
 * health. Preserve the input reference in that case so all three derivations
 * (decay, rules, progress/comments) can keep their existing results.
 * Compare values, not summary identity: store summaries include non-health
 * fields and may be reconstructed after a server acknowledgement.
 */
function sameHealthInputs(
  previous: Map<string, readonly HealthCell[]>,
  current: Map<string, readonly HealthCell[]>,
): boolean {
  if (previous === current) return true
  if (previous.size !== current.size) return false
  const oldFiles = previous.entries()
  for (const [fileId, cells] of current) {
    const old = oldFiles.next().value
    if (!old || old[0] !== fileId) return false
    const before = old[1]
    if (before === cells) continue
    if (before.length !== cells.length) return false
    for (let i = 0; i < cells.length; i++) {
      const a = before[i]
      const b = cells[i]
      if (a === b) continue
      if (a.id !== b.id || a.status !== b.status
        || a.original !== b.original || a.translated !== b.translated
        || a.endorsementCount !== b.endorsementCount
        || a.medium !== b.medium || a.transcription !== b.transcription
        || a.hasOwnTake !== b.hasOwnTake || a.laneStatus !== b.laneStatus
        || a.threads !== b.threads) return false
    }
  }
  return true
}

/** Check one cell and record the fields the result depends on. */
function checkedEntry(
  cell: HealthCell,
  fileId: string,
  enabledRules: TranslationRule[],
  rulesForCell: HealthDispatchOptions["rulesForCell"],
  cellCheckContext: HealthDispatchOptions["cellCheckContext"],
): RuleCacheEntry {
  return {
    fileId, status: cell.status, original: cell.original, translated: cell.translated,
    medium: cell.medium, transcription: cell.transcription, hasOwnTake: cell.hasOwnTake,
    infractions: checkRulesForCell(
      cell as CellData,
      fileId,
      rulesForCell ? rulesForCell(cell, fileId, enabledRules) : enabledRules,
      cellCheckContext?.(cell, fileId),
    ),
  }
}

export function useHealth(
  inputFileCells: Map<string, readonly HealthCell[]>,
  rules: TranslationRule[] = [],
  options: HealthDispatchOptions = {},
): HealthStats {
  const previousInputs = useRef(inputFileCells)
  const fileCells = useMemo(() => {
    if (sameHealthInputs(previousInputs.current, inputFileCells)) return previousInputs.current
    previousInputs.current = inputFileCells
    return inputFileCells
  }, [inputFileCells])
  const requiredValidations = options.requiredValidations ?? 1
  const enabled = options.enabled ?? true
  const decaySettingsKey = JSON.stringify(options.decaySettings ?? null) + `|${requiredValidations}`

  // AD-14: health (project / file / per-cell) derives from decay, computed
  // purely from each cell's endorsement_count. The endorsement target defaults
  // to the project's required-validations gate (see resolveDecayConfig) so a
  // validated cell reaches full health.
  const decay = useMemo(() => {
    if (!enabled) return DISABLED_DECAY
    const end = perfMark("useHealth.computeDecayHealth")
    const settings = resolveDecayConfig(options.decaySettings, requiredValidations)
    const r = computeDecayHealth(fileCells, settings)
    end()
    memMark("useHealth.decay")
    return r
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileCells, decaySettingsKey, enabled])

  // Rule / built-in-check violations — a SEPARATE sibling surface (AD-14), not
  // folded into health. Incremental: every commit revalidates the cells array
  // and rebuilds `fileCells` to a new Map ref, so a naive full pass re-evaluates
  // every cell for every keystroke-blur (8+s on a Bible book). Rules are pure
  // per-cell (see rule-engine.ts), so we cache infractions keyed on each cell's
  // individual input fields and only re-run `checkRulesForCell` for cells whose
  // text, status, media transcript, recording presence, or file actually changed.
  const infractionsCacheRef = useRef<{
    rulesSig: string
    byCell: Map<string, RuleCacheEntry>
  }>({ rulesSig: "", byCell: new Map() })

  // AQU-934 phase 3a: the per-cell composer is rebuilt whenever the library
  // changes, so its identity is NOT a memo dependency — `librarySig` carries
  // the invalidation, and the ref keeps the latest callable without re-walking
  // every cell on an unrelated caller re-render.
  const rulesForCellRef = useRef(options.rulesForCell)
  rulesForCellRef.current = options.rulesForCell
  const librarySig = options.rulesForCellSig ?? ""
  // AQU-1688: same contract as the composer above — identity is not a
  // dependency, the signature carries the invalidation.
  const cellCheckContextRef = useRef(options.cellCheckContext)
  cellCheckContextRef.current = options.cellCheckContext
  const contextSig = options.cellCheckContextSig ?? ""
  // A resolver can put library rules on a cell whose project rule set is
  // empty, so the "no rules at all" early return below must account for it.
  // An explicit "" sig is the composer saying nothing in the library can lint;
  // an absent sig alongside a resolver is unknown, so assume it may.
  const libraryMayLint = options.rulesForCell !== undefined && options.rulesForCellSig !== ""

  // `enabledRules` + `rulesSig` depend only on `rules`, which changes far less
  // often than `fileCells` (every keystroke rebuilds the cells map). Hoisting
  // them here keeps the JSON.stringify over potentially hundreds of terminology
  // rules off the per-keystroke path — the infractions memo below re-runs on
  // every edit, but now reuses these stable values instead of re-serializing.
  const { enabledRules, rulesSig } = useMemo(() => {
    const enabled = rules.filter((r) => r.enabled)
    const sig = JSON.stringify(enabled.map((r) => [r.id, r.name, r.check]))
    const withLibrary = librarySig ? `${sig}|${librarySig}` : sig
    return {
      enabledRules: enabled,
      rulesSig: contextSig ? `${withLibrary}|ctx:${contextSig}` : withLibrary,
    }
  }, [rules, librarySig, contextSig])

  // AQU-2654: cells the pass below left for the background, and a counter the
  // background bumps when it has filled the cache in for them.
  const deferredRef = useRef<{ rulesSig: string; cells: Array<{ fileId: string; cell: HealthCell }> } | null>(null)
  const [backgroundPasses, setBackgroundPasses] = useState(0)

  const infractions = useMemo(() => {
    deferredRef.current = null
    if (!enabled) {
      infractionsCacheRef.current = { rulesSig: "", byCell: new Map() }
      return EMPTY_INFRACTIONS
    }
    const end = perfMark("useHealth.checkRules")
    const cache = infractionsCacheRef.current
    const rulesChanged = cache.rulesSig !== rulesSig

    const byCell = cache.byCell
    let visited = 0
    const result = new Map<string, RuleInfraction[]>()

    if (enabledRules.length === 0 && !libraryMayLint) {
      infractionsCacheRef.current = { rulesSig, byCell: new Map() }
      end()
      return result
    }

    const rulesForCell = rulesForCellRef.current
    const cellCheckContext = cellCheckContextRef.current
    // Cells are checked in file order, so what is left for the background when
    // the budget runs out is the far end of the file, not the top of it.
    const compiledBefore = conceptPatternsCompiled()
    const deferred: Array<{ fileId: string; cell: HealthCell }> = []
    for (const [fileId, cells] of fileCells) {
      for (const cell of cells) {
        visited++
        const prev = rulesChanged ? undefined : byCell.get(cell.id)
        // Resolve the cell's rule set only on a MISS — `rulesForCell` walks the
        // applicability graph, which is exactly the cost this cache exists to
        // keep off the keystroke path.
        const hit = prev && prev.fileId === fileId
          && prev.status === cell.status && prev.original === cell.original
          && prev.translated === cell.translated && prev.medium === cell.medium
          && prev.transcription === cell.transcription && prev.hasOwnTake === cell.hasOwnTake
        if (!hit && conceptPatternsCompiled() - compiledBefore > SYNC_PATTERN_BUDGET) {
          // Over budget: this cell is checked in the background. Whatever the
          // cache holds for it belongs to other content or other rules.
          byCell.delete(cell.id)
          deferred.push({ fileId, cell })
          continue
        }
        const entry = hit
          ? prev
          : checkedEntry(cell, fileId, enabledRules, rulesForCell, cellCheckContext)
        if (entry !== prev) byCell.set(cell.id, entry)
        if (entry.infractions.length > 0) result.set(cell.id, entry.infractions)
      }
    }
    if (deferred.length > 0) {
      deferredRef.current = { rulesSig, cells: deferred }
      pendingCounts.set(result, deferred.length)
    }

    // Insertions/updates are already reflected in byCell. A size mismatch
    // means entries may have left the loaded files; prune only then rather
    // than copying tens of thousands of unchanged entries on every save.
    if (byCell.size !== visited) {
      const retained = new Set<string>()
      for (const cells of fileCells.values()) for (const cell of cells) retained.add(cell.id)
      for (const id of byCell.keys()) if (!retained.has(id)) byCell.delete(id)
    }
    infractionsCacheRef.current = { rulesSig, byCell }
    end()
    memMark("useHealth.checkRules")
    return result
    // `backgroundPasses`: the background filled the cache in; read it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileCells, enabledRules, rulesSig, enabled, libraryMayLint, backgroundPasses])
  const infractionsPending = pendingCounts.get(infractions) ?? 0

  // AQU-2654: check the deferred cells in idle slices, straight into the cache
  // the pass above reads, then run that pass once more — it finds every cell
  // cached and publishes the complete map. One extra commit, at the end, not
  // one per slice: each publish re-renders the workspace.
  useEffect(() => {
    const job = deferredRef.current
    if (!job) return
    let next = 0
    let disposed = false
    let cancel: (() => void) | null = null
    const runSlice = () => {
      cancel = null
      if (disposed) return
      const cache = infractionsCacheRef.current
      // Superseded: a newer pass owns the cache and has its own deferred list.
      if (cache.rulesSig !== job.rulesSig || deferredRef.current !== job) return
      const deadline = performance.now() + BACKGROUND_SLICE_MS
      do {
        const { fileId, cell } = job.cells[next++]
        cache.byCell.set(
          cell.id,
          checkedEntry(cell, fileId, enabledRules, rulesForCellRef.current, cellCheckContextRef.current),
        )
      } while (next < job.cells.length && performance.now() < deadline)
      if (next < job.cells.length) cancel = scheduleSlice(runSlice)
      else setBackgroundPasses((n) => n + 1)
    }
    cancel = scheduleSlice(runSlice)
    return () => {
      disposed = true
      cancel?.()
    }
    // Keyed on the pass's own output: a new pass is a new deferred list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infractions])

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
      ...(infractionsPending > 0 ? { infractionsPending } : {}),
      openCommentCount: aux.openCommentCount,
      projectOpenCommentCount: aux.projectOpenCommentCount,
      cellOpenCommentCount: aux.cellOpenCommentCount,
    }),
    [decay, infractions, infractionsPending, aux, effectiveProjectHealth, effectiveFileHealth],
  )

  // Structural stability: if the raw result is semantically unchanged from
  // last render, return the previous reference so React.memo on downstream
  // consumers (every row in the virtualized list) can hold. A no-rule keystroke
  // finishes the equality walk in a few ms and saves a full re-render of
  // every visible row.
  const prevRef = useRef<HealthStats | null>(null)
  // An equivalent new result may reuse an older reference. Remember that
  // comparison for this raw result so unrelated renders do not walk every
  // cell again. All health/rule/comment inputs still invalidate `raw` above.
  return useMemo(() => {
    if (prevRef.current && healthStatsEqual(prevRef.current, raw)) {
      return prevRef.current
    }
    prevRef.current = raw
    return raw
  }, [raw])
}

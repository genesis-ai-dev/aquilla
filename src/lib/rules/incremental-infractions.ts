/**
 * Incremental, interruptible project-wide rule scan (AQU-1864).
 *
 * The rules pane needs violation counts over the WHOLE corpus, and the corpus
 * is the whole project: a full Bible is ~31k cells and ~20 enabled rules, so
 * the naive scan is ~600k rule evaluations. Run inside a render-time memo it
 * froze the page for seconds on open, and again on every outbox change —
 * `useProjectCells` republishes the corpus on each one, which invalidated the
 * memo even though at most one cell had actually changed.
 *
 * So the scan is split into two parts, and this module owns the hard one:
 *
 * - **Incremental.** Per-cell results are cached and reused. Re-scanning a
 *   republished corpus only evaluates the cells whose rule-visible fields
 *   differ, so a keystroke in one cell costs one cell's worth of work rather
 *   than the project's. `checkRulesForCell` is pure per cell, which is what
 *   makes that sound.
 * - **Interruptible.** Work is pulled in bounded slices (`step`), never in one
 *   blocking pass, and a partial result is publishable at any point. The
 *   scheduling policy — how big a slice, and when to run the next one — is the
 *   caller's (see `useProjectInfractions`); this module stays synchronous and
 *   deterministic so it can be unit-tested without timers.
 *
 * The published map is byte-for-byte what the old eager memo produced: keyed
 * by `cell.id`, only cells with infractions present, last cell of a duplicated
 * id winning — the counts on screen must not move because of this change.
 */
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import type { CellData } from "@/hooks/useCells"
import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"

/** Cell fields `checkRulesForCell` reads. Anything else can change freely. */
interface CellFingerprint {
  id: string
  original: string
  medium: CellData["medium"]
  transcription: CellData["transcription"]
  translated: string
  status: CellData["status"]
  hasOwnTake: boolean
}

function fingerprint(cell: CellData): CellFingerprint {
  return {
    id: cell.id,
    original: cell.original,
    medium: cell.medium,
    transcription: cell.transcription,
    translated: cell.translated,
    status: cell.status,
    hasOwnTake: !!cell.hasOwnTake,
  }
}

function sameCell(a: CellFingerprint, b: CellFingerprint): boolean {
  return (
    a.id === b.id &&
    a.original === b.original &&
    a.medium === b.medium &&
    a.transcription === b.transcription &&
    a.translated === b.translated &&
    a.status === b.status &&
    a.hasOwnTake === b.hasOwnTake
  )
}

/** Cache key. Cell ids are unique per file, not per project. */
function cacheKey(fileId: string, cellId: string): string {
  return `${fileId}\u0000${cellId}`
}

interface CacheEntry {
  cell: CellFingerprint
  /** The rule ids+bodies this result was computed against. */
  rulesKey: string
  infractions: RuleInfraction[]
}

/**
 * Identity of the rule set as the engine sees it. A rule's pattern, severity
 * and lane all change its infractions, so the whole serialized rule takes
 * part: anything less risks showing counts from a stale rule body.
 */
export function rulesFingerprint(enabledRules: readonly TranslationRule[]): string {
  return JSON.stringify(enabledRules)
}

export interface ScanProgress {
  /** Cells whose result still has to be computed. */
  pending: number
  /** Cells in the corpus. */
  total: number
}

type CheckCell = (
  cell: CellData,
  fileId: string,
  enabledRules: TranslationRule[],
) => RuleInfraction[]

/**
 * A reusable scan over one project corpus.
 *
 * Lifecycle: `plan(cells, rules)` on every input change, then `step(n)` until
 * it returns true, calling `snapshot()` whenever you want to publish what is
 * known so far. Re-planning keeps the cache, which is the whole point.
 */
export class InfractionScan {
  private cache = new Map<string, CacheEntry>()
  /** The planned corpus, in input order — defines snapshot() key precedence. */
  private cells: CellData[] = []
  private rules: TranslationRule[] = []
  private rulesKey = rulesFingerprint([])
  /** Indexes into `cells` still to evaluate, consumed from the end. */
  private queue: number[] = []
  private readonly checkCell: CheckCell

  constructor(checkCell: CheckCell = checkRulesForCell) {
    this.checkCell = checkCell
  }

  /**
   * Point the scan at a corpus + rule set, reusing every cached cell result
   * that is still valid. Returns what is left to do.
   *
   * A changed rule set invalidates everything — there is no sound way to reuse
   * per-cell results across rule bodies.
   */
  plan(cells: readonly CellData[], enabledRules: readonly TranslationRule[]): ScanProgress {
    const rulesKey = rulesFingerprint(enabledRules)
    if (rulesKey !== this.rulesKey) {
      this.cache.clear()
      this.rulesKey = rulesKey
    }
    this.rules = [...enabledRules]
    this.cells = [...cells]
    this.queue = []

    if (this.rules.length === 0) {
      // No rules, no infractions. Keep the (now empty) cache coherent so a
      // later re-enable doesn't serve results from the previous rule set.
      this.cache.clear()
      return { pending: 0, total: this.cells.length }
    }

    const live = new Set<string>()
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i]
      const key = cacheKey(cell.fileId, cell.id)
      live.add(key)
      const hit = this.cache.get(key)
      if (hit && hit.rulesKey === rulesKey && sameCell(hit.cell, fingerprint(cell))) continue
      this.queue.push(i)
    }
    // Drop cells that left the corpus (deleted file, lane switch) so the cache
    // tracks the project rather than growing for the life of the page.
    if (this.cache.size > live.size) {
      for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key)
    }
    // Consumed from the end; reverse so cells are evaluated in corpus order
    // and a partial snapshot reads top-down like the list it feeds.
    this.queue.reverse()
    return { pending: this.queue.length, total: this.cells.length }
  }

  /** Evaluate at most `maxCells` queued cells. True once the scan is complete. */
  step(maxCells: number): boolean {
    let budget = Math.max(1, maxCells)
    while (budget > 0 && this.queue.length > 0) {
      const index = this.queue.pop()
      if (index === undefined) break
      const cell = this.cells[index]
      if (!cell) continue
      this.cache.set(cacheKey(cell.fileId, cell.id), {
        cell: fingerprint(cell),
        rulesKey: this.rulesKey,
        infractions: this.checkCell(cell, cell.fileId, this.rules),
      })
      budget--
    }
    return this.queue.length === 0
  }

  get pending(): number {
    return this.queue.length
  }

  get done(): boolean {
    return this.queue.length === 0
  }

  /**
   * The infractions known right now, in the shape the rules UI consumes.
   * Cells not yet evaluated are simply absent, so counts only ever grow
   * towards the true total as the scan proceeds.
   */
  snapshot(): Map<string, RuleInfraction[]> {
    const out = new Map<string, RuleInfraction[]>()
    if (this.rules.length === 0) return out
    for (const cell of this.cells) {
      const hit = this.cache.get(cacheKey(cell.fileId, cell.id))
      if (!hit || hit.rulesKey !== this.rulesKey) continue
      if (hit.infractions.length === 0) continue
      out.set(cell.id, hit.infractions)
    }
    return out
  }
}

/**
 * The eager equivalent, kept for tests and for callers with a corpus small
 * enough that slicing is pointless. Identical output to the scan's terminal
 * snapshot.
 */
export function scanAllCells(
  cells: readonly CellData[],
  enabledRules: readonly TranslationRule[],
): Map<string, RuleInfraction[]> {
  const scan = new InfractionScan()
  scan.plan(cells, enabledRules)
  while (!scan.step(cells.length || 1)) { /* bounded by the corpus */ }
  return scan.snapshot()
}

import {
  buildHealthRibbon,
  preTranslationEvidence,
  type HealthRibbonInput,
  type HealthRibbonPoint,
  type HealthRibbonStage,
} from "./health-ribbon"

/**
 * The slice of a cell view the health ribbon reads. Kept minimal so the cache
 * below can be fed from `CellViewModel`, `CellSummary`, or a test fixture.
 */
export interface RibbonInputCell {
  id: string
  fileId: string
  status: string
  translated: string
  group?: string
  section?: string
}

export interface RibbonEvidenceReaders<C extends RibbonInputCell> {
  /** Source text as shown to the reader (transcript for media cells). */
  sourceText(cell: C): string
  /** Automatic-stage health estimate for the cell, if any. */
  health(cellId: string): number | undefined
  /** Retrieval examples for the cell. Must be replaced, not mutated, on refresh. */
  examples(cellId: string): Array<{ matchedTokens: string[] }>
}

export interface RibbonInputReaders<C extends RibbonInputCell> extends RibbonEvidenceReaders<C> {
  /** Monotonic per-cell version from the cell store; changes whenever the cell's data changes. */
  getCellVersion(cellId: string): number
  /** Resolves the cell view. Only called when the cached input is stale. */
  getCell(cellId: string): C | null
}

export function ribbonStage(cell: { status: string; translated: string }): HealthRibbonStage {
  return cell.status === "validated"
    ? "validated"
    : cell.status === "empty" || !cell.translated.trim()
      ? "untranslated"
      : "automatic"
}

export function ribbonScope(cell: { fileId: string; group?: string; section?: string }): string {
  return `${cell.fileId}:${cell.group || cell.section || "document"}`
}

/** The ribbon input for one cell, derived exactly as the editor table did before AQU-1104. */
export function ribbonInputFor<C extends RibbonInputCell>(
  cellId: string,
  cell: C | null,
  readers: RibbonEvidenceReaders<C>,
): HealthRibbonInput {
  if (!cell) return { id: cellId, scope: "missing", stage: "untranslated" }
  const stage = ribbonStage(cell)
  const pre = stage === "untranslated"
    ? preTranslationEvidence(readers.sourceText(cell), readers.examples(cellId))
    : null
  return {
    id: cellId,
    scope: ribbonScope(cell),
    stage,
    rawScore: stage === "validated"
      ? 100
      : stage === "automatic"
        ? readers.health(cellId)
        : pre?.score,
    evidenceWeight: pre?.evidenceWeight ?? 1,
  }
}

interface RibbonInputEntry {
  version: number
  health: number | undefined
  examples: unknown
  input: HealthRibbonInput
}

export interface RibbonInputCache {
  /**
   * Ribbon inputs for `cellIds`, in order. A cell whose store version, health
   * value, and examples array are unchanged since the last read reuses its
   * previous input without resolving the view again.
   */
  read<C extends RibbonInputCell>(cellIds: readonly string[], readers: RibbonInputReaders<C>): HealthRibbonInput[]
  /**
   * The smoothed ribbon for `cellIds`. Points whose values are unchanged
   * since the previous call keep their previous object identity, so a row
   * memoized on its point does not re-render for a commit elsewhere in the file.
   */
  ribbon<C extends RibbonInputCell>(cellIds: readonly string[], readers: RibbonInputReaders<C>): Map<string, HealthRibbonPoint>
  /** Number of inputs rebuilt by the last `read`. Exposed for tests and profiling. */
  readonly lastRebuilt: number
  clear(): void
}

function pointsEqual(a: HealthRibbonPoint, b: HealthRibbonPoint): boolean {
  return a.stage === b.stage
    && a.rawScore === b.rawScore
    && a.smoothedScore === b.smoothedScore
    && a.topScore === b.topScore
    && a.bottomScore === b.bottomScore
    && a.topOpacity === b.topOpacity
    && a.bottomOpacity === b.bottomOpacity
    && a.evidenceWeight === b.evidenceWeight
}

/** `next` with every point equal to its `previous` counterpart replaced by that counterpart. */
export function stabilizeRibbonPoints(
  previous: ReadonlyMap<string, HealthRibbonPoint>,
  next: Map<string, HealthRibbonPoint>,
): Map<string, HealthRibbonPoint> {
  if (previous.size === 0) return next
  for (const [id, point] of next) {
    const before = previous.get(id)
    if (before && pointsEqual(before, point)) next.set(id, before)
  }
  return next
}

/**
 * AQU-1104: the editor table rebuilt every cell's ribbon input on every cell
 * store version bump, which meant re-deriving 30k cell views per commit on a
 * whole-Bible file. Cell versions are per cell, so only the cells a commit
 * touched need a fresh view; everything else keeps its previous input.
 */
export function createRibbonInputCache(): RibbonInputCache {
  let byId = new Map<string, RibbonInputEntry>()
  let lastCellIds: string[] = []
  let lastRebuilt = 0
  let previousPoints: Map<string, HealthRibbonPoint> = new Map()
  let previousInputs: HealthRibbonInput[] | null = null
  const cache: RibbonInputCache = {
    get lastRebuilt() {
      return lastRebuilt
    },
    ribbon(cellIds, readers) {
      const inputs = cache.read(cellIds, readers)
      const previous = previousInputs
      if (previous && inputs.length === previous.length
        && inputs.every((input, index) => input === previous[index])) return previousPoints
      previousPoints = stabilizeRibbonPoints(previousPoints, buildHealthRibbon(inputs))
      previousInputs = inputs
      return previousPoints
    },
    read(cellIds, readers) {
      let orderChanged = cellIds.length !== lastCellIds.length
      let rebuilt = 0
      const inputs = cellIds.map((cellId, index) => {
        if (cellId !== lastCellIds[index]) orderChanged = true
        const version = readers.getCellVersion(cellId)
        const health = readers.health(cellId)
        const examples = readers.examples(cellId)
        const prev = byId.get(cellId)
        if (prev && prev.version === version && prev.health === health && prev.examples === examples) {
          return prev.input
        }
        rebuilt++
        const derived = ribbonInputFor(cellId, readers.getCell(cellId), readers)
        // A new cell version can be a save acknowledgement or a text edit
        // whose score/stage/evidence did not change. Preserve the input's
        // identity only after checking every field the smoother consumes.
        const input = prev && prev.input.id === derived.id
          && prev.input.scope === derived.scope
          && prev.input.stage === derived.stage
          && prev.input.rawScore === derived.rawScore
          && prev.input.evidenceWeight === derived.evidenceWeight
          ? prev.input : derived
        byId.set(cellId, { version, health, examples, input })
        return input
      })
      // Keep unchanged entries in place. Rebuilding a 30k-entry Map on each
      // save costs more than updating the few entries whose inputs changed.
      // Compare actual IDs, not array identity: a display order can mutate.
      if (orderChanged) {
        const retained = new Set(cellIds)
        for (const id of byId.keys()) if (!retained.has(id)) byId.delete(id)
        lastCellIds = [...cellIds]
      }
      lastRebuilt = rebuilt
      return inputs
    },
    clear() {
      byId = new Map()
      lastCellIds = []
      lastRebuilt = 0
      previousPoints = new Map()
      previousInputs = null
    },
  }
  return cache
}

const cacheByOwner = new WeakMap<object, RibbonInputCache>()

/**
 * The ribbon input cache for one cell store. Per-cell versions are only
 * comparable within a store, so the cache lives and dies with it. One editor
 * table reads a store at a time, so sharing the cache per store is safe.
 */
export function ribbonInputCacheFor(store: object): RibbonInputCache {
  let cache = cacheByOwner.get(store)
  if (!cache) {
    cache = createRibbonInputCache()
    cacheByOwner.set(store, cache)
  }
  return cache
}

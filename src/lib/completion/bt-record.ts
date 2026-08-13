/**
 * Back-translation of record — the persisted reading of a cell's translation.
 *
 * A reading is only trustworthy when the user can see:
 *   1. what produced it (AI vs a human correction)
 *   2. whether it still describes the text on screen
 *
 * The server pins each row to `targetEventId`. The client also stores `forText`
 * (the exact target string that was read) so unsaved drafts and event-id lag
 * cannot silently present an old reading as current.
 */

/** Explicit user action that may persist a BT — never implied by a commit. */
export type BacktranslationActionSource = "read-back" | "refresh" | "regenerate"

export interface BacktranslationRecord {
  cellId: string
  btText: string
  /** Target commit this reading was pinned to. Empty when unknown. */
  targetEventId: string
  /**
   * Exact target text this reading describes. Empty only for server-hydrated
   * rows whose pin we have not yet compared to the live cell.
   */
  forText: string
  /** true = model-produced; false = a human corrected the reading. */
  polished: boolean
  author?: string
  createdAt: number
}

export interface BtFewShotExample {
  target: string
  backtranslation: string
}

const LS_PREFIX = "bt:"

function collapseWs(s: string): string {
  return s.trim().replace(/\s+/g, " ")
}

export function sameTargetText(a: string, b: string): boolean {
  return collapseWs(a) === collapseWs(b)
}

export function normalizeReading(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

/**
 * True when the AI reading and the project's statistical gloss disagree
 * enough to be worth showing. Agreement is quiet; disagreement is the clue.
 */
export function readingsDisagree(aiReading: string, statisticalGloss: string): boolean {
  const a = normalizeReading(aiReading)
  const b = normalizeReading(statisticalGloss)
  if (!a || !b) return false
  return a !== b
}

export function isBacktranslationStale(args: {
  record: BacktranslationRecord | undefined
  committedTranslated: string
  committedTargetEventId: string | undefined
  visibleTranslated: string
}): boolean {
  const { record, committedTranslated, committedTargetEventId, visibleTranslated } = args
  if (!record?.btText.trim()) return false

  const described = record.forText
    || (record.targetEventId
      && committedTargetEventId
      && record.targetEventId === committedTargetEventId
      ? committedTranslated
      : "")

  if (described) return !sameTargetText(described, visibleTranslated)

  // Server row with no forText and a pin that does not match the live head.
  if (record.targetEventId && committedTargetEventId) {
    return record.targetEventId !== committedTargetEventId
  }
  return true
}

export function overlayBacktranslation<T extends {
  id: string
  translated: string
  targetEventId?: string
}>(
  cell: T,
  record: BacktranslationRecord | undefined,
  projectId?: string | null,
): T & {
  backtranslation?: string
  backtranslationForText?: string
  backtranslationTargetEventId?: string
  backtranslationPolished?: boolean
  backtranslationAuthor?: string
} {
  const resolved = record ?? (projectId ? readLocalBacktranslation(projectId, cell.id) : undefined)
  if (!resolved?.btText) return cell

  const forText = resolved.forText
    || (resolved.targetEventId && cell.targetEventId && resolved.targetEventId === cell.targetEventId
      ? cell.translated
      : "")

  return {
    ...cell,
    backtranslation: resolved.btText,
    backtranslationForText: forText,
    backtranslationTargetEventId: resolved.targetEventId || undefined,
    backtranslationPolished: resolved.polished,
    backtranslationAuthor: resolved.author,
  }
}

export function localStorageKey(projectId: string, cellId: string): string {
  return `${LS_PREFIX}${projectId}:${cellId}`
}

export function readLocalBacktranslation(projectId: string, cellId: string): BacktranslationRecord | undefined {
  if (typeof localStorage === "undefined") return undefined
  try {
    const raw = localStorage.getItem(localStorageKey(projectId, cellId))
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Partial<BacktranslationRecord> & { btText?: string }
    if (!parsed.btText) return undefined
    return {
      cellId,
      btText: parsed.btText,
      targetEventId: parsed.targetEventId ?? "",
      forText: parsed.forText ?? "",
      polished: Boolean(parsed.polished),
      author: parsed.author,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
    }
  } catch {
    return undefined
  }
}

export function writeLocalBacktranslation(projectId: string, record: BacktranslationRecord): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(localStorageKey(projectId, record.cellId), JSON.stringify(record))
  } catch {
    // quota / private browsing — the in-memory cache still holds the reading
  }
}

export function recordFromHydrationRow(row: {
  cellId: string
  targetEventId: string
  btText: string
  polished: boolean
  author: string
  createdAt: number
}): BacktranslationRecord {
  return {
    cellId: row.cellId,
    btText: row.btText,
    targetEventId: row.targetEventId,
    forText: "",
    polished: row.polished,
    author: row.author,
    createdAt: row.createdAt,
  }
}

/**
 * Few-shot examples for the LLM path. Human-corrected readings are the
 * statistical clue the model was missing — they teach project wording.
 * Stale rows (pin no longer matches the live target head) are skipped so
 * we never train the next reading on an outdated pair.
 */
export function selectBtFewShotExamples(args: {
  records: Iterable<BacktranslationRecord>
  corpusByCellId: ReadonlyMap<string, { translated?: string; targetEventId?: string }>
  currentCellId: string
  limit?: number
}): BtFewShotExample[] {
  const limit = args.limit ?? 4
  const corrected: BtFewShotExample[] = []
  const generated: BtFewShotExample[] = []

  for (const record of args.records) {
    if (record.cellId === args.currentCellId) continue
    if (!record.btText.trim()) continue
    const cell = args.corpusByCellId.get(record.cellId)
    const target = (record.forText || cell?.translated || "").trim()
    if (!target) continue
    if (record.targetEventId && cell?.targetEventId && record.targetEventId !== cell.targetEventId) {
      continue
    }
    const example = { target, backtranslation: record.btText.trim() }
    if (record.polished === false) corrected.push(example)
    else generated.push(example)
  }

  return [...corrected, ...generated].slice(0, limit)
}

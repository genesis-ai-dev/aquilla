/**
 * Message protocol between the main thread and the BIA forecast worker, and
 * the one function that answers a message — shared by the worker and the
 * in-thread fallback so the two can never disagree.
 */

import { BiaEngine, endsInsideWord, startsInsideWord, type Suggestion } from "./bia-engine"
import type { ForecastCell } from "./bia-index"

export interface FitResult {
  word: string
  score: number
}

export type ForecastCommand =
  | { type: "upsert"; cells: ForecastCell[] }
  | { type: "remove"; ids: string[] }
  | { type: "clear" }

/**
 * `excludeCellId` is the cell being edited: its stale committed text is left
 * out of the corpus, and its SOURCE verse (fed with the cells) is what the
 * suggestion aligns against. `source` overrides that lookup.
 */
export type ForecastQuery =
  | { kind: "suggest"; left: string; right: string; excludeCellId?: string; source?: string; limit?: number }
  | { kind: "fit"; word: string; left: string; right: string; excludeCellId?: string; source?: string; limit?: number }

export type ForecastRequest = ForecastCommand | { type: "query"; id: number; query: ForecastQuery }

export interface ForecastResponse {
  id: number
  suggestions?: Suggestion[]
  fits?: FitResult[]
  error?: string
}

/** Apply a command to the engine. */
export function applyForecastCommand(engine: BiaEngine, command: ForecastCommand): void {
  if (command.type === "upsert") engine.index.upsert(command.cells)
  else if (command.type === "remove") engine.index.remove(command.ids)
  else engine.index.clear()
}

/**
 * Ghost-text suggestions at a caret: next word(s) at the end of the text,
 * a single infill word between words, nothing in the middle of a word.
 * `insert` is adjusted so accepting it leaves single spaces on both sides.
 */
export function suggestAtCaret(
  engine: BiaEngine,
  left: string,
  right = "",
  opts: { excludeCellId?: string; source?: string; limit?: number } = {},
): Suggestion[] {
  const inside = endsInsideWord(left)
  if (inside && startsInsideWord(right)) return []
  const atEnd = right.trim().length === 0
  const source = sourceFor(engine, opts)
  // An empty cell gets a first word only when its source verse can say what it is.
  if (!left.trim() && !right.trim() && (source === undefined || source.length === 0)) return []
  const suggest = { excludeCellId: opts.excludeCellId, limit: opts.limit, source }
  const results = atEnd ? engine.suggestNext(left, suggest) : engine.suggestInfill(left, right, suggest)
  const needsLeadingSpace = !inside && left.length > 0 && !/\s$/u.test(left)
  const needsTrailingSpace = !atEnd && !/^\s/u.test(right)
  return results
    .filter((s) => s.insert.length > 0)
    .map((s) => ({
      ...s,
      insert: `${needsLeadingSpace ? " " : ""}${s.insert}${needsTrailingSpace ? " " : ""}`,
    }))
}

/** The query's source verse: explicit text, else the edited cell's stored source. */
function sourceFor(engine: BiaEngine, opts: { excludeCellId?: string; source?: string }): string | readonly string[] | undefined {
  if (opts.source !== undefined) return opts.source
  return opts.excludeCellId === undefined ? undefined : engine.index.lexicon.sourceOf(opts.excludeCellId)
}

export function answerForecastQuery(engine: BiaEngine, query: ForecastQuery): Omit<ForecastResponse, "id"> {
  if (query.kind === "suggest") {
    return { suggestions: suggestAtCaret(engine, query.left, query.right, query) }
  }
  return {
    fits: engine.wordsThatFit(query.word, {
      context: { left: query.left, right: query.right },
      excludeCellId: query.excludeCellId,
      source: sourceFor(engine, query),
      limit: query.limit ?? 12,
    }),
  }
}

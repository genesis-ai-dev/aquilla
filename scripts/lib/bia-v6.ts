// Eval-only reconstruction of Codex Editor's 2024-09 TypeScript forecaster
// ("V6", codex-editor c42263ea, src/tsServer/forecasting.ts), as described
// by the history review of that commit. Not shipped; a baseline column.
//
//   - Forward and backward ADJACENT-word (±1) counts over the whole target
//     corpus as one stream: bigrams cross verse boundaries, as in V6.
//   - Next word: forward followers of the last word, most frequent first;
//     if it has none, the followers of the second-to-last word.
//   - Then `getSimilarWords(lastWord)` is appended: for each (left, right)
//     neighbour pair the last word occurs between, every word seen between
//     that left and right neighbour scores +1, and a word that is itself a
//     direct neighbour of the last word scores +2. Duplicates are kept, as V6
//     concatenated the two lists without de-duplicating.
//
// Known deviations: tokens are this repo's forecast-tokenize keys (V6 split
// on whitespace); score ties break by first appearance; V6 offered 5, the
// eval reads the top 3.

export interface V6Forecaster {
  next(left: readonly string[]): string[]
}

type Counts = Map<string, Map<string, number>>

function bump(table: Counts, a: string, b: string): void {
  let row = table.get(a)
  if (!row) {
    row = new Map()
    table.set(a, row)
  }
  row.set(b, (row.get(b) ?? 0) + 1)
}

const ranked = (row: ReadonlyMap<string, number> | undefined): string[] =>
  row ? Array.from(row.entries()).sort((a, b) => b[1] - a[1]).map(([w]) => w) : []

export function buildV6(cells: ReadonlyArray<readonly string[]>): V6Forecaster {
  const stream = cells.flat()
  const forward: Counts = new Map()
  const backward: Counts = new Map()
  /** word → its (left, right) neighbour pairs, counted. */
  const contexts = new Map<string, Map<string, [string, string]>>()
  for (let i = 0; i < stream.length; i++) {
    const w = stream[i]
    if (i > 0) {
      bump(forward, stream[i - 1], w)
      bump(backward, w, stream[i - 1])
    }
    if (i > 0 && i < stream.length - 1) {
      let row = contexts.get(w)
      if (!row) {
        row = new Map()
        contexts.set(w, row)
      }
      row.set(`${stream[i - 1]}\u0000${stream[i + 1]}`, [stream[i - 1], stream[i + 1]])
    }
  }

  const similar = (word: string, need: number): string[] => {
    const scores = new Map<string, number>()
    for (const [l, r] of contexts.get(word)?.values() ?? []) {
      const after = forward.get(l)
      const before = backward.get(r)
      if (!after || !before) continue
      const [small, large] = after.size < before.size ? [after, before] : [before, after]
      for (const w of small.keys()) if (w !== word && large.has(w)) scores.set(w, (scores.get(w) ?? 0) + 1)
    }
    for (const w of [...(forward.get(word)?.keys() ?? []), ...(backward.get(word)?.keys() ?? [])]) {
      if (w !== word) scores.set(w, (scores.get(w) ?? 0) + 2)
    }
    return Array.from(scores.entries()).sort((a, b) => b[1] - a[1]).slice(0, need).map(([w]) => w)
  }

  return {
    next(left) {
      const last = left.at(-1)
      if (last === undefined) return []
      let out = ranked(forward.get(last))
      if (out.length === 0 && left.length > 1) out = ranked(forward.get(left[left.length - 2]))
      // The similar-words tail only matters when the followers run short.
      if (out.length < 5) out = [...out, ...similar(last, 5)]
      return out.slice(0, 5)
    },
  }
}

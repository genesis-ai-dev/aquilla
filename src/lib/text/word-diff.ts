// Minimal word-level diff for the "Upstream changes" review panel (FRO-478).
//
// Not a general-purpose diff library — just enough to highlight what changed
// between an old and new mirrored source string for a readable inline
// review. Uses a classic LCS-over-words backtrack (O(n*m) tokens), which is
// fine at cell-sized text (a subtitle line / verse, not a whole document).

export type DiffOp = "equal" | "insert" | "delete"

export interface DiffToken {
  op: DiffOp
  text: string
}

function tokenize(s: string): string[] {
  // Split on whitespace, keeping the whitespace as its own token so spacing
  // is preserved when re-joining — avoids double-spacing artifacts.
  return s.match(/\s+|\S+/g) ?? []
}

/** Word-level diff of `oldText` → `newText`. Returns a flat token list in
 *  `newText`'s order with `delete` tokens interleaved at their removal point
 *  (so a caller can render old-strikethrough + new-highlight inline). */
export function wordDiff(oldText: string, newText: string): DiffToken[] {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  const n = a.length
  const m = b.length

  // LCS table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const tokens: DiffToken[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      tokens.push({ op: "equal", text: b[j]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      tokens.push({ op: "delete", text: a[i]! })
      i++
    } else {
      tokens.push({ op: "insert", text: b[j]! })
      j++
    }
  }
  while (i < n) {
    tokens.push({ op: "delete", text: a[i]! })
    i++
  }
  while (j < m) {
    tokens.push({ op: "insert", text: b[j]! })
    j++
  }
  return tokens
}

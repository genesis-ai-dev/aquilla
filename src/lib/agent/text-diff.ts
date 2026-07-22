/**
 * text-diff.ts — a small hand-rolled line-level diff (mem-M2/M3), used by
 * BriefPanel to show what a proposed brief update actually changes against
 * the current brief. No diff library dependency: a classic LCS-backtrack
 * over lines is plenty for brief-sized text (a few KB, not a whole repo).
 */

export type DiffLineKind = "context" | "added" | "removed"

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

/** Longest Common Subsequence table over two line arrays. */
function lcsLengths(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  return table
}

/**
 * Line-level diff of `before` against `after`. Returns an ordered list of
 * context/added/removed lines — context lines are unchanged text kept for
 * readability around a change, added/removed are the actual delta.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n")
  const b = after.split("\n")
  const table = lcsLengths(a, b)

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: "removed", text: a[i] })
      i++
    } else {
      out.push({ kind: "added", text: b[j] })
      j++
    }
  }
  while (i < a.length) {
    out.push({ kind: "removed", text: a[i] })
    i++
  }
  while (j < b.length) {
    out.push({ kind: "added", text: b[j] })
    j++
  }
  return out
}

/** True if the diff has at least one added or removed line. */
export function hasChanges(lines: DiffLine[]): boolean {
  return lines.some((l) => l.kind !== "context")
}

/**
 * Counts the header's draft/validate dialog shows under each choice.
 *
 * The dialog does not load every book's cells. These figures are the file
 * rollup the sidebar already has: cells with no translation, cells with a
 * translation nobody has validated, and untouched machine drafts. They follow
 * the books the reader checks. A missing rollup means the dialog keeps its
 * explanation instead of quoting a partial sum.
 *
 * Untouched drafts are known for a one-language project (the files counter is
 * that language) and for the open book (counted from its cells). Several
 * languages and a closed book leave the draft count unknown.
 */
export interface BookBatchCounts {
  empty: number
  /**
   * Untouched AI drafts. Null when this book does not know that number —
   * a sum that treated null as zero would under-count the books the reader
   * checked.
   */
  untouchedAi: number | null
  /**
   * Translations that are not validated. Untouched AI drafts are not in this
   * number when `untouchedAi` is known, because that choice is its own box.
   */
  unsigned: number
}

export function bookBatchCountsEqual(a: BookBatchCounts, b: BookBatchCounts): boolean {
  return a.empty === b.empty && a.unsigned === b.unsigned && a.untouchedAi === b.untouchedAi
}

export function bookCountsFromProgress(stats: {
  translated: number
  validated: number
  total: number
  aiDrafted?: number
} | undefined): BookBatchCounts | null {
  if (!stats) return null
  const empty = Math.max(0, stats.total - stats.translated)
  const unvalidated = Math.max(0, stats.translated - stats.validated)
  if (stats.aiDrafted == null) {
    return { empty, untouchedAi: null, unsigned: unvalidated }
  }
  const untouchedAi = Math.max(0, stats.aiDrafted)
  return { empty, untouchedAi, unsigned: Math.max(0, unvalidated - untouchedAi) }
}

/**
 * The open book's drafts, counted from the cells on screen, in place of the
 * last rollup. Empty and the unvalidated total stay the rollup's, so a closed
 * book added beside it is the same kind of number.
 */
export function withLiveUntouchedAi(counts: BookBatchCounts, untouchedAi: number): BookBatchCounts {
  const unvalidated = counts.unsigned + (counts.untouchedAi ?? 0)
  const ai = Math.max(0, untouchedAi)
  return { empty: counts.empty, untouchedAi: ai, unsigned: Math.max(0, unvalidated - ai) }
}

export interface CheckedBookTotals {
  empty: number
  untouchedAi: number | null
  unsigned: number
}

/** The checked books, added up. Null when any checked book has no rollup yet. */
export function totalsForCheckedBooks(
  books: readonly { id: string }[],
  checked: ReadonlySet<string>,
  counts: ReadonlyMap<string, BookBatchCounts>,
): CheckedBookTotals | null {
  let empty = 0
  let unsigned = 0
  let untouchedAi = 0
  let aiKnown = true
  let saw = false
  for (const book of books) {
    if (!checked.has(book.id)) continue
    saw = true
    const row = counts.get(book.id)
    if (!row) return null
    empty += row.empty
    unsigned += row.unsigned
    if (row.untouchedAi == null) aiKnown = false
    else untouchedAi += row.untouchedAi
  }
  if (!saw) return { empty: 0, untouchedAi: 0, unsigned: 0 }
  return { empty, unsigned, untouchedAi: aiKnown ? untouchedAi : null }
}

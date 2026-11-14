// AQU-1733: a quotation that opens in one cell and is never closed.
//
// WHY: this is the half of "unpaired quotation marks" no per-cell check can
// reach. The motivating case is John 6:26–27 drafted from Greek — the source
// marks no quotations at all, so every cell is internally consistent and only
// the file as a whole is wrong. The two failure modes to guard against are
// missing it (the check's whole point) and crying wolf on a half-translated
// file, where the text that would close the quotation simply isn't written yet.

import { describe, expect, it } from 'vitest'
import { MAX_UNCLOSED_REPORTED, scanQuoteContinuity } from './quote-continuity'
import type { QuoteContinuityResult } from './quote-continuity'
import type { QuoteMarksProfile } from './language-profile'

const ENGLISH: QuoteMarksProfile = {
  levels: [{ open: '“', close: '”' }, { open: '‘', close: '’' }],
  continuation: 'reopen-each-paragraph',
}
const FRENCH: QuoteMarksProfile = {
  levels: [{ open: '«', close: '»' }],
  continuation: 'reopen-each-paragraph',
}

const cells = (...texts: string[]) => texts.map((text, i) => ({ id: `c${i}`, text }))
/** What is reported, without the bookkeeping of which marks were accounted for. */
const reported = (r: QuoteContinuityResult) => ({ unclosed: r.unclosed, strays: r.strays })
const NOTHING = { unclosed: [], strays: [] }

describe('scanQuoteContinuity', () => {
  it('flags a quotation opened in one cell that no later cell closes', () => {
    const { unclosed, strays } = scanQuoteContinuity(
      cells('Jesus answered them, “Truly, truly, I say to you,', 'you seek me not because you saw signs.'),
      ENGLISH,
    )
    expect(strays).toEqual([])
    expect(unclosed).toHaveLength(1)
    expect(unclosed[0]).toMatchObject({ cellId: 'c0', depth: 1, open: '“', close: '”', cellsOpen: 1 })
    // The span is the opening mark itself — where the reviewer has to look.
    expect(unclosed[0].start).toBe(21)
    expect(unclosed[0].end).toBe(22)
  })

  it('flags the same omission inside a single cell', () => {
    const { unclosed } = scanQuoteContinuity(cells('He said, “Come with me.'), ENGLISH)
    expect(unclosed).toHaveLength(1)
    // cellsOpen 0 distinguishes it from the cross-cell case.
    expect(unclosed[0]).toMatchObject({ cellId: 'c0', cellsOpen: 0 })
  })

  it('stays quiet when the quotation is closed in a later cell', () => {
    expect(
      reported(scanQuoteContinuity(cells('He said, “Come with me,', 'and I will make you fishers of men.”'), ENGLISH)),
    ).toEqual(NOTHING)
  })

  it('reads a reopened mark at a new paragraph as a continuation, not a second quotation', () => {
    // The project's own convention: a quotation still open is reopened at each
    // paragraph. Counting that “ as a new quotation would report two unclosed
    // quotations for text that is correct.
    expect(
      reported(scanQuoteContinuity(cells('He said, “The first part.', '“And the second part.”'), ENGLISH)),
    ).toEqual(NOTHING)
  })

  it('does not report a quotation left open where the translation stops', () => {
    // c1 is untranslated: the closing mark may be in the text nobody has
    // written yet. A half-translated book must not report its whole discourse.
    expect(
      reported(scanQuoteContinuity(cells('He said, “Come with me,', '', 'A later verse.'), ENGLISH)),
    ).toEqual(NOTHING)
  })

  it('reports a closing mark with nothing open as a stray', () => {
    const { unclosed, strays } = scanQuoteContinuity(cells('He said, “Come.”', 'And they went.”'), ENGLISH)
    expect(unclosed).toEqual([])
    expect(strays).toHaveLength(1)
    expect(strays[0]).toMatchObject({ cellId: 'c1', close: '”' })
  })

  it('uses the project’s own marks, not English ones', () => {
    expect(scanQuoteContinuity(cells('Il dit : « Venez avec moi,'), FRENCH).unclosed).toHaveLength(1)
    // The same text under English marks shows nothing: « is not a mark there.
    expect(scanQuoteContinuity(cells('Il dit : « Venez avec moi,'), ENGLISH).unclosed).toEqual([])
  })

  it('is not fooled by an apostrophe into reporting an unclosed level-2 quotation', () => {
    expect(reported(scanQuoteContinuity(cells('He said, “Don’t be afraid; it’s I.”'), ENGLISH))).toEqual(
      NOTHING,
    )
  })

  it('a speech reopened in every cell is one open quotation, not one per cell', () => {
    // The paragraph convention is what keeps this check quiet on a long
    // discourse: each cell reopens the quotation already open rather than
    // starting another, so the file reports the one mark that is missing.
    const discourse = cells(...Array.from({ length: 6 }, (_, i) => `“Verse ${i} of the discourse.`))
    const { unclosed } = scanQuoteContinuity(discourse, ENGLISH)
    expect(unclosed).toHaveLength(1)
    expect(unclosed[0]).toMatchObject({ cellId: 'c0', depth: 1, cellsOpen: 5 })
  })

  it('caps how many still-open levels one scan reports', () => {
    // Genuinely nested and all left open: reporting every level says the same
    // thing four times, so only the outermost ones are reported.
    const { unclosed } = scanQuoteContinuity(cells('“a ‘b “c ‘d'), ENGLISH)
    expect(unclosed).toHaveLength(MAX_UNCLOSED_REPORTED)
    // Outermost first: the level a reviewer fixes first.
    expect(unclosed.map((u) => u.depth)).toEqual([1, 2, 3])
  })

  it('reports nothing without a quotation system, or without cells', () => {
    expect(scanQuoteContinuity(cells('He said, “Come.'), null)).toEqual({ unclosed: [], strays: [], matched: [], pending: [] })
    expect(scanQuoteContinuity(cells('He said, “Come.'), { levels: [], continuation: 'none' })).toEqual({
      unclosed: [],
      strays: [],
      matched: [],
      pending: [],
    })
    expect(scanQuoteContinuity([], ENGLISH)).toEqual({ unclosed: [], strays: [], matched: [], pending: [] })
  })
})

describe('the marks the walk accounted for', () => {
  it('names the closing mark alone in its cell, and the opening mark it closes', () => {
    // This is the per-cell check's false alarm: on its own, the second cell
    // holds one quotation mark and nothing to pair it with, and a source that
    // marks no quotations cannot excuse it. The file pairs it perfectly.
    const { matched, unclosed, strays } = scanQuoteContinuity(
      cells('He said, “Come with me,', 'and I will make you fishers of men.”'),
      ENGLISH,
    )
    expect(unclosed).toEqual([])
    expect(strays).toEqual([])
    expect(matched).toEqual([
      { cellId: 'c1', start: 35, end: 36 },
      { cellId: 'c0', start: 9, end: 10 },
    ])
  })

  it('names a paragraph reopen, which opens nothing', () => {
    const { matched } = scanQuoteContinuity(
      cells('He said, “The first part.', '“And the second part.”'),
      ENGLISH,
    )
    expect(matched).toContainEqual({ cellId: 'c1', start: 0, end: 1 })
  })

  it('never names a mark it is reporting', () => {
    const { matched, pending, unclosed } = scanQuoteContinuity(cells('He said, “Come with me.'), ENGLISH)
    expect(unclosed).toHaveLength(1)
    expect(matched).toEqual([])
    expect(pending).toEqual([])
  })
})

describe('the quotations still open where the translation stops', () => {
  // WHY: the walk drops these rather than reporting them, but a per-cell check
  // still sees the opening mark alone in its cell and — against a source that
  // marks no quotations — reports it. Unless the walk says which marks it set
  // aside, the caller cannot withdraw that alarm, and a half-translated file
  // reports the very thing the gap rule promises to keep quiet (PR #1885's QA
  // walk, item 3).
  it('names the opening mark, whether or not the translation resumes', () => {
    const place = { cellId: 'c0', start: 9, end: 10 }
    for (const texts of [
      ['He said, “Come with me,', ''],
      ['He said, “Come with me,', '', 'A later verse.'],
      ['He said, “Come with me,', '   '],
    ]) {
      const { pending, unclosed, matched } = scanQuoteContinuity(cells(...texts), ENGLISH)
      expect(pending).toEqual([place])
      expect(unclosed).toEqual([])
      expect(matched).toEqual([])
    }
  })

  it('names every level still open, and the cell each opened in', () => {
    const { pending } = scanQuoteContinuity(cells('He said, “Listen:', 'the prophet wrote, ‘Prepare', ''), ENGLISH)
    expect(pending).toEqual([
      { cellId: 'c0', start: 9, end: 10 },
      { cellId: 'c1', start: 19, end: 20 },
    ])
  })

  it('names nothing once the gap is translated — the quotation is then reported', () => {
    const { pending, unclosed } = scanQuoteContinuity(
      cells('He said, “Come with me,', 'and I will make you fishers of men.'),
      ENGLISH,
    )
    expect(pending).toEqual([])
    expect(unclosed).toHaveLength(1)
  })

  it('keeps a quotation opened after the gap apart from the one before it', () => {
    const { pending, unclosed } = scanQuoteContinuity(
      cells('He said, “Come with me,', '', 'She said, “Go.'),
      ENGLISH,
    )
    expect(pending).toEqual([{ cellId: 'c0', start: 9, end: 10 }])
    expect(unclosed).toEqual([expect.objectContaining({ cellId: 'c2', cellsOpen: 0 })])
  })
})

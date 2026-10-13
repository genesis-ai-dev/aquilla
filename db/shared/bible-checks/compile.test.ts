// AQU-1688: compiling pack facts into per-cell expectations.
//
// WHY: the expectation is the only thing a cell's check knows about the rest of
// the passage. If it says a quotation continues when it closes, or treats a
// bridge or a split verse as an ordinary verse, every check built on it reports
// the wrong thing. Real pack data: __fixtures__/pack.ts.

import { describe, it, expect } from 'vitest'
import { compileCellExpectation, compileFileExpectations } from './compile'
import { evaluateCell } from './evaluate'
import { expandCellRefs } from './refs'
import { JHN4_STRUCTURE, JHN4_VOICES, MAT_STRUCTURE, MAT_VOICES } from './__fixtures__/pack'
import type { LanguageProfile } from '../language-profile'

const ENGLISH: LanguageProfile = {
  quoteMarks: {
    levels: [{ open: '“', close: '”' }, { open: '‘', close: '’' }],
    continuation: 'reopen-each-paragraph',
  },
}

describe('a speech that runs across verses (JHN 4:11–12)', () => {
  it('opens in 4:11 and is still open when 4:11 ends', () => {
    const e = compileCellExpectation(['JHN 4:11'], JHN4_VOICES, JHN4_STRUCTURE)!
    expect(e.speeches[0]).toMatchObject({ opens: true, closes: false, openAtEnd: true, continues: false })
    expect([e.startDepth, e.endDepth]).toEqual([0, 1])
  })

  it('is open when 4:12 starts and closes in it', () => {
    const e = compileCellExpectation(['JHN 4:12'], JHN4_VOICES, JHN4_STRUCTURE)!
    expect(e.speeches[0]).toMatchObject({ opens: false, closes: true, openAtStart: true })
    expect([e.startDepth, e.endDepth]).toEqual([1, 0])
  })

  it('a verse wholly inside a speech only continues it (MAT 5:17 in the Sermon on the Mount)', () => {
    const e = compileCellExpectation(['MAT 5:17'], MAT_VOICES, MAT_STRUCTURE)!
    expect(e.speeches).toHaveLength(1)
    expect(e.speeches[0]).toMatchObject({ continues: true, openAtStart: true, openAtEnd: true })
    expect(e.boundaries).toBe(false)
  })
})

describe('a bridge cell is evaluated over all its verses', () => {
  it('“JHN 4:11-12” holds the whole speech: it opens and closes in the cell', () => {
    const e = compileCellExpectation(['JHN 4:11-12'], JHN4_VOICES, JHN4_STRUCTURE)!
    expect(e.refs).toEqual(['JHN 4:11', 'JHN 4:12'])
    expect(e.speeches[0]).toMatchObject({ opens: true, closes: true, openAtStart: false, openAtEnd: false })
    expect(e.approximate).toBe(false)
  })

  it('several refs mean the same as a range', () => {
    const range = compileCellExpectation(['JHN 4:11-12'], JHN4_VOICES, JHN4_STRUCTURE)
    const list = compileCellExpectation(['JHN 4:11', 'JHN 4:12'], JHN4_VOICES, JHN4_STRUCTURE)
    expect(list).toEqual(range)
  })

  it('so a close at the end of 4:11’s words is wrong in a 4:11 cell, and right at the end of a 4:11–12 cell', () => {
    const verse11 = 'The woman said to him, “Sir, you have nothing to draw with, and the well is deep.”'
    const alone = compileCellExpectation(['JHN 4:11'], JHN4_VOICES, JHN4_STRUCTURE)
    expect(evaluateCell(verse11, alone, ENGLISH).map((f) => f.code)).toContain('bkp:V3')
    const bridge = compileCellExpectation(['JHN 4:11-12'], JHN4_VOICES, JHN4_STRUCTURE)
    const bridged = verse11.replace('deep.”', 'deep. Are you greater than our father Jacob?”')
    expect(evaluateCell(bridged, bridge, ENGLISH)).toEqual([])
  })
})

describe('a split verse (two cells share one ref) is checked at verse level only', () => {
  const split = compileFileExpectations(
    [
      { id: 'a', globalReferences: ['JHN 4:9'] },
      { id: 'b', globalReferences: ['JHN 4:9'] },
      { id: 'c', globalReferences: ['JHN 4:8'] },
    ],
    JHN4_VOICES,
    JHN4_STRUCTURE,
  )

  it('marks both parts approximate, and only them', () => {
    expect(split.get('a')!.approximate).toBe(true)
    expect(split.get('b')!.approximate).toBe(true)
    expect(split.get('c')!.approximate).toBe(false)
  })

  it('does not ask a part for the open, the close or the ? that the other part may hold', () => {
    const firstHalf = 'The Samaritan woman therefore said to him, “How is it that you, being a Jew,'
    const secondHalf = 'ask for a drink from me, a Samaritan woman” For Jews have no dealings with Samaritans.'
    expect(evaluateCell(firstHalf, split.get('a'), ENGLISH)).toEqual([])
    expect(evaluateCell(secondHalf, split.get('b'), ENGLISH)).toEqual([])
  })

  it('still applies a fact that holds for every part: no quotation marks where nobody speaks', () => {
    const parts = compileFileExpectations(
      [
        { id: 'a', globalReferences: ['JHN 4:8a'] },
        { id: 'b', globalReferences: ['JHN 4:8b'] },
      ],
      JHN4_VOICES,
      JHN4_STRUCTURE,
    )
    const [finding] = evaluateCell('“For his disciples had gone away into the city', parts.get('a'), ENGLISH)
    expect(finding).toMatchObject({ code: 'bkp:V7', approximate: true })
  })

  it('and inside a quotation that runs through the whole verse, no part may close it', () => {
    const parts = compileFileExpectations(
      [
        { id: 'a', globalReferences: ['MAT 5:17'] },
        { id: 'b', globalReferences: ['MAT 5:17'] },
      ],
      MAT_VOICES,
      MAT_STRUCTURE,
    )
    const [finding] = evaluateCell('I didn’t come to destroy, but to fulfill.”', parts.get('b'), ENGLISH)
    expect(finding).toMatchObject({ code: 'bkp:V3', approximate: true })
  })
})

describe('when the pack has nothing to say', () => {
  it('a heading or chapter ref has no expectation', () => {
    expect(compileCellExpectation(['JHN 4'], JHN4_VOICES, JHN4_STRUCTURE)).toBeNull()
  })

  it('a verse the voices layer lacks has no expectation, even inside a bridge', () => {
    expect(compileCellExpectation(['JHN 4:16'], JHN4_VOICES, JHN4_STRUCTURE)).toBeNull()
    expect(compileCellExpectation(['JHN 4:15-16'], JHN4_VOICES, JHN4_STRUCTURE)).toBeNull()
  })

  it('refs that skip a verse are not treated as one passage', () => {
    expect(compileCellExpectation(['JHN 4:7', 'JHN 4:9'], JHN4_VOICES, JHN4_STRUCTURE)).toBeNull()
  })

  it('without the structure layer, quotation facts still compile but no question is expected', () => {
    const e = compileCellExpectation(['JHN 4:9'], JHN4_VOICES, null)!
    expect(e.speeches).toHaveLength(1)
    expect(e.question.expected).toBe(false)
  })
})

describe('expandCellRefs', () => {
  it('expands a range and keeps verse order', () => {
    expect(expandCellRefs(['MRK 1:1-3'])).toEqual({ book: 'MRK', verses: ['MRK 1:1', 'MRK 1:2', 'MRK 1:3'], partial: false })
  })

  it('reads a verse part as partial', () => {
    expect(expandCellRefs(['JHN 4:9b'])).toEqual({ book: 'JHN', verses: ['JHN 4:9'], partial: true })
  })

  it('refuses mixed books and backwards ranges', () => {
    expect(expandCellRefs(['JHN 4:9', 'MRK 1:1'])).toBeNull()
    expect(expandCellRefs(['JHN 4:9-7'])).toBeNull()
  })

  it('handles numbered books', () => {
    expect(expandCellRefs(['1JN 1:1'])?.verses).toEqual(['1JN 1:1'])
  })
})

// AQU-1688: reading quotation marks level by level.
//
// WHY: every quotation check compares these counts with the pack. A mark read
// at the wrong level (or an apostrophe read as a closing quote) becomes a false
// finding in every verse that contains it.

import { describe, it, expect } from 'vitest'
import { markSetForDepth, scanQuotes } from './quote-scan'
import type { QuoteMarksProfile } from '../language-profile'

const ENGLISH: QuoteMarksProfile = {
  levels: [{ open: '“', close: '”' }, { open: '‘', close: '’' }, { open: '“', close: '”' }],
  continuation: 'reopen-each-paragraph',
}

const summary = (text: string, marks: QuoteMarksProfile, startDepth = 0) =>
  scanQuotes(text, marks, startDepth).tokens.map((t) => `${t.kind}:${t.depth}/${t.set}`)

describe('scanQuotes', () => {
  it('reads English nesting “ ‘ “ … ” ’ ” as levels 1, 2 and 3', () => {
    expect(summary('“a ‘b “c” d’ e”', ENGLISH)).toEqual([
      'open:1/1', 'open:2/2', 'open:3/3', 'close:3/3', 'close:2/2', 'close:1/1',
    ])
  })

  it('records a level-2 quotation opened with level-1 marks, so V5 can see it', () => {
    expect(summary('“a “b” c”', ENGLISH)).toEqual(['open:1/1', 'open:2/1', 'close:2/1', 'close:1/1'])
  })

  it('skips apostrophes inside words and a ’ that closes nothing', () => {
    expect(summary('don’t take the disciples’ bread', ENGLISH)).toEqual([])
    // Inside a level-2 quotation, an apostrophe between letters still does not close it.
    expect(summary('‘don’t go’', { ...ENGLISH, levels: [{ open: '‘', close: '’' }] })).toEqual(['open:1/1', 'close:1/1'])
  })

  it('reads a stray closing mark as a close with no open', () => {
    expect(summary('he said.”', ENGLISH)).toEqual(['stray-close:1/1'])
  })

  it('starts inside the quotations already open, and reads a leading reopen as a continuation', () => {
    expect(summary('“and more,” he said.', ENGLISH, 1)).toEqual(['continuation:1/1', 'close:1/1'])
    expect(summary('and more.”', ENGLISH, 1)).toEqual(['close:1/1'])
  })

  it('reads a paragraph reopen inside a verse as a continuation (WEB, MAT 13:28)', () => {
    // The parable goes on (level 1 open); a new paragraph starts mid-verse.
    const web = '“He said to them, ‘An enemy has done this.’ “The servants asked him, ‘Do you want us to go?’'
    expect(summary(web, ENGLISH, 1)).toEqual([
      'continuation:1/1', 'open:2/2', 'close:2/2', 'continuation:1/1', 'open:2/2', 'close:2/2',
    ])
  })

  it('reopens every open level in a run (“‘), but not after a comma, where “ is a new quotation', () => {
    expect(summary('and so it ended. “‘And then', ENGLISH, 2)).toEqual(['continuation:1/1', 'continuation:2/2'])
    expect(summary('who says to you, “Give', ENGLISH, 1)).toEqual(['open:2/1'])
  })

  it('does not reopen under the other conventions', () => {
    // The lone ’ closes nothing, so it is read as an apostrophe; “ opens a level-2 quotation with level-1 marks.
    expect(summary('this.’ “The servants', { ...ENGLISH, continuation: 'none' }, 1)).toEqual(['open:2/1'])
  })

  it('reads a continuation-mark convention (Spanish » at a new paragraph) as a continuation, not a close', () => {
    const spanish: QuoteMarksProfile = {
      levels: [{ open: '«', close: '»' }, { open: '“', close: '”' }],
      continuation: 'continuation-mark',
    }
    expect(summary('» y más.', spanish, 1)).toEqual(['continuation:1/1'])
    expect(summary('» y más.', { ...spanish, continuation: 'none' }, 1)).toEqual(['close:1/1'])
  })

  it('handles symmetric marks (Swedish ” ”) by closing the open one first', () => {
    const swedish: QuoteMarksProfile = { levels: [{ open: '”', close: '”' }], continuation: 'none' }
    expect(summary('”Ge mig” sade han', swedish)).toEqual(['open:1/1', 'close:1/1'])
  })

  it('handles German „ “ where English would read “ as an opening mark', () => {
    const german: QuoteMarksProfile = {
      levels: [{ open: '„', close: '“' }, { open: '‚', close: '‘' }],
      continuation: 'reopen-each-paragraph',
    }
    expect(summary('„Gib mir ‚Wasser‘ zu trinken“', german)).toEqual(['open:1/1', 'open:2/2', 'close:2/2', 'close:1/1'])
  })

  it('closing an outer quotation also closes the ones inside it', () => {
    const scan = scanQuotes('“a ‘b c”', ENGLISH, 0)
    expect(scan.tokens.map((t) => `${t.kind}:${t.depth}`)).toEqual(['open:1', 'open:2', 'close:1'])
    expect(scan.finalDepth).toBe(0)
  })

  it('reports offsets into the text, surrogate pairs included', () => {
    const text = '𝔄 “x”'
    const [open, close] = scanQuotes(text, ENGLISH, 0).tokens
    expect(text.slice(open.start, open.end)).toBe('“')
    expect(text.slice(close.start, close.end)).toBe('”')
  })
})

describe('markSetForDepth', () => {
  it('uses each defined level, then alternates the last two (English “ ‘ “ ‘, German „ ‚ „ ‚)', () => {
    expect([1, 2, 3, 4, 5, 6].map((d) => markSetForDepth(d, 3))).toEqual([1, 2, 3, 2, 3, 2])
    expect([1, 2, 3, 4].map((d) => markSetForDepth(d, 2))).toEqual([1, 2, 1, 2])
    expect([1, 2, 3].map((d) => markSetForDepth(d, 1))).toEqual([1, 1, 1])
  })
})

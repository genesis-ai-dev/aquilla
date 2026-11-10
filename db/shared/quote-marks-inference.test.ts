import { describe, expect, it } from 'vitest'
import { inferQuoteContinuation, inferQuoteMarks, quotePairScore } from './quote-marks-inference'

const pair = (open: string, close: string) => ({ open, close })

describe('inferQuoteMarks — the quotation system a project already shows', () => {
  it('returns null for a project that has not quoted anything', () => {
    expect(inferQuoteMarks(['In the beginning God created the heavens and the earth.', 'And the earth was formless.'])).toBeNull()
  })

  it('learns the English double/single system, nested levels in order', () => {
    const profile = inferQuoteMarks([
      'Jesus said, “Why do you call me good?”',
      'He answered, “It is written, ‘Man shall not live by bread alone.’”',
      'They asked, “Who then is this?”',
    ])
    expect(profile).toEqual({
      levels: [pair('“', '”'), pair('‘', '’')],
      continuation: 'reopen-each-paragraph',
    })
  })

  it('learns the guillemet system a Spanish or Russian project uses', () => {
    const profile = inferQuoteMarks([
      'Jesús dijo: «¿Por qué me llamas bueno?»',
      'Él respondió: «Está escrito: “No solo de pan vive el hombre”».',
      'Y preguntaron: «¿Quién es este?»',
    ])
    expect(profile?.levels).toEqual([pair('«', '»'), pair('“', '”')])
  })

  it('learns the German system, whose closing mark is another pair’s opening mark', () => {
    const profile = inferQuoteMarks([
      'Jesus sprach: „Warum nennst du mich gut?“',
      'Er antwortete: „Es steht geschrieben: ‚Der Mensch lebt nicht vom Brot allein.‘“',
      'Und sie fragten: „Wer ist dieser?“',
    ])
    // „ … “ claims “, so “ … ” can no longer be a level: overlapping levels
    // would make every mark ambiguous.
    expect(profile?.levels).toEqual([pair('„', '“'), pair('‚', '‘')])
  })

  it('does not mistake apostrophes for a quotation level', () => {
    const profile = inferQuoteMarks([
      'He said, “I don’t know the man’s name.”',
      'She said, “That isn’t what they’re asking.”',
    ])
    expect(profile?.levels).toEqual([pair('“', '”')])
  })

  it('learns the pair even when the project’s only quotation was left unclosed', () => {
    expect(inferQuoteMarks(['Jesus answered, “I am the bread of life', 'whoever comes to me will never hunger.'])?.levels).toEqual([
      pair('“', '”'),
    ])
  })

  it('prefers the validated cells when any of them quote', () => {
    const profile = inferQuoteMarks(
      ['A draft with «guillemets» everywhere.', 'More «drafted» «text» «here».'],
      { validatedTexts: ['The agreed rendering: “thus says the Lord”.'] },
    )
    expect(profile?.levels).toEqual([pair('“', '”')])
  })

  it('falls back to the whole corpus when nothing validated quotes anything', () => {
    const profile = inferQuoteMarks(
      ['A draft with «guillemets».'],
      { validatedTexts: ['No quotation here at all.'] },
    )
    expect(profile?.levels).toEqual([pair('«', '»')])
  })

  it('keeps at most three levels', () => {
    const profile = inferQuoteMarks([
      '“a ‘b 「c 『d』 c」 b’ a”',
      '“e ‘f 「g」 f’ e”',
    ])
    expect(profile?.levels.length).toBeLessThanOrEqual(3)
  })
})

describe('inferQuoteContinuation — read at the seam between two cells', () => {
  const english = [pair('“', '”'), pair('‘', '’')]

  it('reads a reopened mark as the reopen-each-paragraph convention', () => {
    const { style, seams } = inferQuoteContinuation(
      ['Jesus said, “Do not be afraid.', '“I am with you always.”'],
      english,
    )
    expect(style).toBe('reopen-each-paragraph')
    expect(seams).toBe(1)
  })

  it('reads a closing mark at the start of a continued cell as a continuation mark', () => {
    const { style } = inferQuoteContinuation(
      ['Él dijo: «No temas.', '»Yo estoy contigo.»'],
      [pair('«', '»')],
    )
    expect(style).toBe('continuation-mark')
  })

  it('reads an unmarked continued cell as no convention', () => {
    const { style } = inferQuoteContinuation(
      ['Jesus said, “Do not be afraid.', 'I am with you always.”'],
      english,
    )
    expect(style).toBe('none')
  })

  it('keeps the forgiving default when the sample has no seam to read', () => {
    const { style, seams } = inferQuoteContinuation(['“One cell, one quotation.”'], english)
    expect(style).toBe('reopen-each-paragraph')
    expect(seams).toBe(0)
  })
})

describe('quotePairScore', () => {
  it('scores a complete pair above a lone opening mark', () => {
    expect(quotePairScore(['“a”'], pair('“', '”'))).toBeGreaterThan(quotePairScore(['“a'], pair('“', '”')))
  })

  it('scores a pair the text never uses at zero', () => {
    expect(quotePairScore(['plain text'], pair('«', '»'))).toBe(0)
  })
})

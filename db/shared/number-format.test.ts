import { describe, it, expect } from 'vitest'
import {
  numberFormatForLanguage,
  numberFormatProfileForLanguage,
  resolveNumberFormat,
} from './number-format'

// AQU-2430. The point of this file is the DISCIPLINE around `Intl`, not the
// CLDR numbers themselves: `Intl` answers for a language it has never heard of
// by quietly resolving to en-US, and throws outright on a freeform label. Both
// have to come out as "no conventions", because the alternative is reporting
// correct typography in every language CLDR does not list.

describe('numberFormatForLanguage', () => {
  it('reads the separators, the grouping and the digits off CLDR', () => {
    expect(numberFormatForLanguage('en')?.conventions).toMatchObject({
      group: [','],
      decimal: ['.'],
      groupSizes: [3],
      digits: [],
    })
    expect(numberFormatForLanguage('de')?.conventions).toMatchObject({
      group: ['.'],
      decimal: [','],
      groupSizes: [3],
    })
  })

  it('reads the Indian lakh grouping as the two run lengths it uses', () => {
    expect(numberFormatForLanguage('hi')?.conventions.groupSizes).toEqual([2, 3])
  })

  it("records a language's own digits, which Western digits are then allowed beside", () => {
    const burmese = numberFormatForLanguage('my')
    expect(burmese?.conventions.digits).toContain('၄')
    expect(burmese?.conventions.digits).not.toContain('4')
  })

  it('resolves a three-letter code and a region the same as the language', () => {
    expect(numberFormatForLanguage('deu')?.locale).toBe('de')
    expect(numberFormatForLanguage('ar-EG')?.conventions.decimal).toEqual(['٫'])
  })

  it('has no answer for a language CLDR does not list, rather than en-US', () => {
    // `new Intl.NumberFormat('qqq')` returns an en-US formatter without
    // complaint — judging a minority language by English would report every
    // comma in it.
    expect(numberFormatForLanguage('qqq')).toBeNull()
    expect(numberFormatForLanguage('und')).toBeNull()
  })

  it('resolves a freeform label the normalizer knows, as punctuation does', () => {
    // `laneLanguageForChecks` hands over whatever the user typed when the
    // catalog has no code for the lane.
    expect(numberFormatForLanguage('Thai')?.locale).toBe('th')
  })

  it('has no answer for a label that is not a language tag, which Intl rejects outright', () => {
    expect(numberFormatForLanguage('Not A Language')).toBeNull()
    expect(numberFormatForLanguage('')).toBeNull()
    expect(numberFormatForLanguage(null)).toBeNull()
  })
})

describe('resolveNumberFormat', () => {
  it('uses the language when no slot is filled', () => {
    const resolved = resolveNumberFormat({ language: 'de' })
    expect(resolved.origin).toEqual({ kind: 'language', locale: 'de' })
    expect(resolved.conventions?.decimal).toEqual([','])
  })

  it('leaves the check silent with neither a language nor a slot', () => {
    expect(resolveNumberFormat({ language: 'qqq' })).toEqual({
      conventions: null,
      origin: { kind: 'unknown-language' },
    })
    expect(resolveNumberFormat({}).conventions).toBeNull()
  })

  it('lets the project override one role and keeps CLDR for the other', () => {
    const resolved = resolveNumberFormat({ language: 'de', profile: { group: ["'"] } })
    expect(resolved.origin).toEqual({ kind: 'profile' })
    expect(resolved.conventions).toMatchObject({ group: ["'"], decimal: [','], groupSizes: [3] })
  })

  it('gives a language CLDR does not list the check once the slot is answered', () => {
    const resolved = resolveNumberFormat({ language: 'qqq', profile: { group: [' '], decimal: [','] } })
    expect(resolved.conventions).toMatchObject({
      group: [' '],
      decimal: [','],
      // Nothing but Western digits, which every language is allowed, and the
      // grouping every language but the Indian-numbering ones uses.
      digits: [],
      groupSizes: [3],
    })
  })

  it('ignores an empty slot — it is not an answer', () => {
    expect(resolveNumberFormat({ language: 'de', profile: {} }).origin).toEqual({
      kind: 'language',
      locale: 'de',
    })
  })
})

describe('numberFormatProfileForLanguage', () => {
  it('gives the settings row something to open pre-filled with', () => {
    expect(numberFormatProfileForLanguage('de')).toEqual({ group: ['.'], decimal: [','] })
    expect(numberFormatProfileForLanguage('qqq')).toBeNull()
  })

  it('copies, so a row cannot edit the cache every project on the page shares', () => {
    const first = numberFormatProfileForLanguage('en')
    first?.group?.push('!')
    expect(numberFormatProfileForLanguage('en')).toEqual({ group: [','], decimal: ['.'] })
  })
})

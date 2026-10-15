import { describe, expect, it } from 'vitest'
import {
  UNIVERSAL_PUNCTUATION,
  punctuationConventionsForLanguage,
  resolvePunctuation,
} from './punctuation-conventions'

describe('punctuationConventionsForLanguage (AQU-1906)', () => {
  it('knows a language by its code, its name and its ISO 639-2/B alias', () => {
    expect(punctuationConventionsForLanguage('th')?.subtag).toBe('th')
    expect(punctuationConventionsForLanguage('Thai')?.subtag).toBe('tha')
    // The ISO 639-2/B alias resolves through normalizeLanguageTag when the
    // table has no key of its own for it.
    expect(punctuationConventionsForLanguage('bur')?.conventions.statement).toContain('။')
    expect(punctuationConventionsForLanguage('Greek')?.conventions.question).toContain(';')
  })

  it('matches a region-tagged code on its primary subtag', () => {
    expect(punctuationConventionsForLanguage('ar-EG')?.subtag).toBe('ar')
  })

  it('matches a script subtag when the primary subtag is unknown', () => {
    expect(punctuationConventionsForLanguage('bho-Deva')?.subtag).toBe('deva')
  })

  it('says nothing about a language it does not list', () => {
    expect(punctuationConventionsForLanguage('es')).toBeNull()
    expect(punctuationConventionsForLanguage('Potato')).toBeNull()
    expect(punctuationConventionsForLanguage('')).toBeNull()
    expect(punctuationConventionsForLanguage(null)).toBeNull()
  })

  it('adds a language\'s marks to the universal ones rather than replacing them', () => {
    const greek = punctuationConventionsForLanguage('el')!.conventions
    expect(greek.question).toContain(';') // Greek asks with ";"
    expect(greek.question).toContain('?') // and an ASCII "?" is still a question
    expect(greek.semicolon).toEqual(expect.arrayContaining([...UNIVERSAL_PUNCTUATION.semicolon, '·']))
  })

  it('lists no mark under two classes, so classification order cannot matter', () => {
    for (const code of ['ar', 'el', 'hi', 'hy', 'am', 'my', 'zh', 'ja', 'km', 'ur']) {
      const c = punctuationConventionsForLanguage(code)!.conventions
      const terminal = [...c.question, ...c.exclamation, ...c.statement]
      expect(new Set(terminal).size, `${code} lists a terminal mark twice`).toBe(terminal.length)
    }
  })

  it('marks Thai, Lao and Khmer as ending a sentence with no mark', () => {
    for (const code of ['th', 'lo', 'km']) {
      expect(punctuationConventionsForLanguage(code)!.conventions.noTerminalMark).toBe(true)
    }
    expect(punctuationConventionsForLanguage('ar')!.conventions.noTerminalMark).toBe(false)
  })
})

describe('resolvePunctuation (AQU-1906)', () => {
  it('returns nothing for a lane with no language — the checks stay source-relative', () => {
    expect(resolvePunctuation({})).toEqual({ conventions: null, origin: { kind: 'source-relative' } })
    expect(resolvePunctuation({ language: 'Spanish' })).toEqual({
      conventions: null,
      origin: { kind: 'source-relative' },
    })
  })

  it('uses the language table when no profile slot is filled', () => {
    const resolved = resolvePunctuation({ language: 'th' })
    expect(resolved.origin).toEqual({ kind: 'language', subtag: 'th' })
    expect(resolved.conventions?.noTerminalMark).toBe(true)
  })

  it('lets a filled profile win WHOLE over the table', () => {
    const resolved = resolvePunctuation({ language: 'th', profile: { statement: ['¶'] } })
    expect(resolved.origin).toEqual({ kind: 'profile' })
    // The table's Thai answer is not blended in.
    expect(resolved.conventions?.noTerminalMark).toBe(false)
    expect(resolved.conventions?.statement).toContain('¶')
  })

  it('treats an empty profile object as no answer at all', () => {
    expect(resolvePunctuation({ language: 'es', profile: {} }).origin).toEqual({ kind: 'source-relative' })
  })
})

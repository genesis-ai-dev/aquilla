// AQU-1596 — the declared-languages contract: a file's language claim is import
// information under a name that says so, and is never read as a lane's language.

import { describe, it, expect } from 'vitest'
import {
  DECLARED_SOURCE_LANGUAGE_KEY,
  DECLARED_TARGET_LANGUAGE_KEY,
  assignDeclaredLanguages,
  readDeclaredLanguages,
} from './file-declared-languages'

describe('readDeclaredLanguages', () => {
  it('reads the canonical declared keys', () => {
    expect(
      readDeclaredLanguages({ declaredSourceLanguage: 'hbo', declaredTargetLanguage: 'fra' }),
    ).toEqual({ declaredSourceLanguage: 'hbo', declaredTargetLanguage: 'fra' })
  })

  it('accepts the legacy camelCase keys as declared values', () => {
    expect(readDeclaredLanguages({ sourceLanguage: 'eng', targetLanguage: 'spa' })).toEqual({
      declaredSourceLanguage: 'eng',
      declaredTargetLanguage: 'spa',
    })
  })

  it('accepts the legacy snake_case keys as declared values', () => {
    expect(readDeclaredLanguages({ source_language: 'eng', target_language: 'spa' })).toEqual({
      declaredSourceLanguage: 'eng',
      declaredTargetLanguage: 'spa',
    })
  })

  // The blob is history and is never rewritten, so a declared key written today
  // sits next to whatever legacy key an older write left behind. The newer,
  // honestly-named value has to win or the rename would be a no-op.
  it('prefers the declared key over a legacy key left in the same blob', () => {
    expect(
      readDeclaredLanguages({
        declaredSourceLanguage: 'hbo',
        sourceLanguage: 'eng',
        source_language: 'deu',
      }).declaredSourceLanguage,
    ).toBe('hbo')
  })

  it('keeps the pre-existing snake_case-before-camelCase precedence among the legacy keys', () => {
    expect(
      readDeclaredLanguages({ source_language: 'deu', sourceLanguage: 'eng' })
        .declaredSourceLanguage,
    ).toBe('deu')
  })

  it('skips a blank legacy value rather than letting it mask a real declared one', () => {
    expect(
      readDeclaredLanguages({ sourceLanguage: '   ', declaredSourceLanguage: 'hbo' })
        .declaredSourceLanguage,
    ).toBe('hbo')
  })

  it('returns nulls for a missing, blank, malformed or non-object blob', () => {
    const none = { declaredSourceLanguage: null, declaredTargetLanguage: null }
    expect(readDeclaredLanguages({})).toEqual(none)
    expect(readDeclaredLanguages(undefined)).toEqual(none)
    expect(readDeclaredLanguages(null)).toEqual(none)
    expect(readDeclaredLanguages('not an object')).toEqual(none)
    expect(readDeclaredLanguages(['hbo'])).toEqual(none)
    expect(readDeclaredLanguages({ sourceLanguage: '' })).toEqual(none)
    expect(readDeclaredLanguages({ sourceLanguage: 42 })).toEqual(none)
  })

  it('returns the value as stored, so callers choose whether to normalize', () => {
    expect(readDeclaredLanguages({ declaredSourceLanguage: ' French ' }).declaredSourceLanguage)
      .toBe(' French ')
  })
})

describe('assignDeclaredLanguages', () => {
  it('writes the canonical declared keys and nothing else', () => {
    const meta: Record<string, unknown> = {}
    assignDeclaredLanguages(meta, 'hbo', 'fra')
    expect(meta).toEqual({
      [DECLARED_SOURCE_LANGUAGE_KEY]: 'hbo',
      [DECLARED_TARGET_LANGUAGE_KEY]: 'fra',
    })
    expect(meta).not.toHaveProperty('sourceLanguage')
    expect(meta).not.toHaveProperty('targetLanguage')
  })

  // Matches the `if (payload.sourceLanguage)` guards this replaced: an import
  // that names no language must not blank out a claim recorded earlier.
  it('writes nothing for an absent, blank or non-string claim', () => {
    const meta: Record<string, unknown> = {}
    assignDeclaredLanguages(meta, undefined, undefined)
    assignDeclaredLanguages(meta, '', '   ')
    assignDeclaredLanguages(meta, 42, null)
    expect(meta).toEqual({})
  })

  it('leaves legacy keys in an existing blob untouched, and still reads back as declared', () => {
    const meta: Record<string, unknown> = { sourceLanguage: 'eng', orderedBy: 'time' }
    assignDeclaredLanguages(meta, 'hbo', undefined)
    expect(meta.sourceLanguage).toBe('eng')
    expect(meta.orderedBy).toBe('time')
    expect(readDeclaredLanguages(meta).declaredSourceLanguage).toBe('hbo')
  })

  it('round-trips through assign → read', () => {
    const meta: Record<string, unknown> = {}
    assignDeclaredLanguages(meta, 'grc', 'swh')
    expect(readDeclaredLanguages(meta)).toEqual({
      declaredSourceLanguage: 'grc',
      declaredTargetLanguage: 'swh',
    })
  })
})

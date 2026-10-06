// AQU-1688: the `languageProfile` project setting.
//
// WHY: checks stay dormant until a slot is filled, so a profile that is stored
// but unreadable must count as unset (dormant), never as half-set (noisy). And
// agents write settings through PatchSettings, which validates with the same
// rules: a typo must fail at prepare instead of being stored and ignored.

import { describe, it, expect } from 'vitest'
import {
  filledLanguageProfileSlots,
  isQuoteMarkCharacter,
  languageProfileProblem,
  readLanguageProfile,
} from './language-profile'
import { settingsKeyDocLines, validateSettingsKeyValue } from './project-settings-keys'

const quoteMarks = {
  levels: [{ open: '“', close: '”' }, { open: '‘', close: '’' }],
  continuation: 'reopen-each-paragraph',
}

describe('languageProfileProblem', () => {
  it('accepts an empty profile and a full quotation-mark slot', () => {
    expect(languageProfileProblem({})).toBeNull()
    expect(languageProfileProblem({ quoteMarks })).toBeNull()
    expect(languageProfileProblem({ quoteMarks: { ...quoteMarks, levels: [{ open: '«', close: '»' }] } })).toBeNull()
  })

  it('rejects an unknown slot, so a typo is not stored and silently ignored', () => {
    expect(languageProfileProblem({ quoteMark: quoteMarks })).toMatch(/unknown slot "quoteMark"/)
  })

  it('needs 1 to 3 levels of single punctuation characters and a known continuation', () => {
    expect(languageProfileProblem({ quoteMarks: { ...quoteMarks, levels: [] } })).toMatch(/1 to 3/)
    const four = [...quoteMarks.levels, ...quoteMarks.levels]
    expect(languageProfileProblem({ quoteMarks: { ...quoteMarks, levels: four } })).toMatch(/1 to 3/)
    expect(languageProfileProblem({ quoteMarks: { ...quoteMarks, levels: [{ open: '<<', close: '>>' }] } })).toMatch(/one punctuation/)
    expect(languageProfileProblem({ quoteMarks: { ...quoteMarks, levels: [{ open: 'a', close: 'b' }] } })).toMatch(/one punctuation/)
    expect(languageProfileProblem({ quoteMarks: { ...quoteMarks, continuation: 'repeat' } })).toMatch(/continuation/)
    expect(languageProfileProblem({ quoteMarks: { ...quoteMarks, style: 'x' } })).toMatch(/unknown field/)
  })

  it('a quote mark is exactly one character that is not a letter, digit or space', () => {
    expect(isQuoteMarkCharacter('「')).toBe(true)
    expect(isQuoteMarkCharacter('»')).toBe(true)
    expect(isQuoteMarkCharacter(' ')).toBe(false)
    expect(isQuoteMarkCharacter('')).toBe(false)
    expect(isQuoteMarkCharacter('7')).toBe(false)
  })
})

describe('the languageProfile settings key', () => {
  it('accepts a valid profile and null to clear', () => {
    expect(validateSettingsKeyValue('languageProfile', { quoteMarks })).toBeNull()
    expect(validateSettingsKeyValue('languageProfile', null)).toBeNull()
  })

  it('names the field at fault when it rejects a value', () => {
    const problem = validateSettingsKeyValue('languageProfile', { quoteMarks: { ...quoteMarks, continuation: 'x' } })
    expect(problem).toMatch(/languageProfile/)
    expect(problem).toMatch(/continuation must be one of/)
  })

  it('documents the slot shape for describe_command', () => {
    const line = settingsKeyDocLines().find((l) => l.startsWith('languageProfile:'))
    expect(line).toContain('quoteMarks')
    expect(line).toContain('"continuation-mark"')
  })
})

describe('readLanguageProfile', () => {
  it('reads a JSONB object and a JSON string the same way', () => {
    expect(readLanguageProfile({ quoteMarks })).toEqual({ quoteMarks })
    expect(readLanguageProfile(JSON.stringify({ quoteMarks }))).toEqual({ quoteMarks })
  })

  it('drops an invalid slot, which leaves its checks dormant', () => {
    expect(readLanguageProfile({ quoteMarks: { levels: [], continuation: 'none' } })).toEqual({})
    expect(filledLanguageProfileSlots(readLanguageProfile({ quoteMarks: 'yes' }))).toEqual(new Set())
  })

  it('reads anything else as an empty profile', () => {
    for (const raw of [null, undefined, 'not json', ['quoteMarks'], 7]) expect(readLanguageProfile(raw)).toEqual({})
  })

  it('reports which slots are filled', () => {
    expect(filledLanguageProfileSlots({ quoteMarks: readLanguageProfile({ quoteMarks }).quoteMarks })).toEqual(
      new Set(['quoteMarks']),
    )
    expect(filledLanguageProfileSlots(null)).toEqual(new Set())
  })
})

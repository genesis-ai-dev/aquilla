// AQU-1688: the `languageProfile` project setting.
//
// WHY: checks stay dormant until a slot is filled, so a profile that is stored
// but unreadable must count as unset (dormant), never as half-set (noisy). And
// agents write settings through PatchSettings, which validates with the same
// rules: a typo must fail at prepare instead of being stored and ignored.

import { describe, it, expect } from 'vitest'
import {
  LANGUAGE_PROFILE_SLOTS,
  filledLanguageProfileSlots,
  isQuoteMarkCharacter,
  languageProfileProblem,
  readLanguageProfile,
  type LanguageProfile,
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

// AQU-1691: the slots after the quotation marks. Each one validates on its own,
// so a typo from an agent fails at prepare and names the field, and a stored
// slot that is damaged drops alone instead of silencing its neighbours.
const FULL: LanguageProfile = {
  quoteMarks: { levels: [{ open: '“', close: '”' }], continuation: 'none' },
  questionMarkers: { suffix: ['ko'], particles: ['吗'] },
  pronouns: {
    secondPerson: { numberDistinction: true, singular: ['yu'], plural: ['yupela'] },
    firstPersonPlural: { clusivity: true, inclusive: ['yumi'], exclusive: ['mipela'] },
    extraNumbers: { dual: true, dualForms: ['yutupela'] },
    thirdPerson: { genderOrClass: false },
    honorifics: { levels: [{ name: 'Familiar', forms: ['tu'] }, { name: 'Polite', forms: ['vous'] }] },
  },
  negators: ['ne', 'pas'],
  numberWords: { '1': 'one', '12': 'twelve' },
  speechVerbs: ['said', 'asked'],
  kinTerms: { relativeAgeDistinction: true, notes: 'kakak / adik' },
  divineNames: { yhwh: 'the LORD', deityPronounCapitalization: false, kyriosJesus: 'Lord', kyriosGod: 'the Lord' },
  measures: 'convert',
  textualVariants: 'footnote',
  headings: 'pericope',
}

describe('the AQU-1691 slots', () => {
  it('accepts a profile with every slot filled, and "cldr" number words', () => {
    expect(languageProfileProblem(FULL)).toBeNull()
    expect(languageProfileProblem({ numberWords: 'cldr' })).toBeNull()
    // An empty question-markers slot is a real answer: "?" only.
    expect(languageProfileProblem({ questionMarkers: {} })).toBeNull()
  })

  it.each([
    [{ questionMarkers: { suffix: ['k o'] } }, /questionMarkers\.suffix\[0\] must not contain spaces/],
    [{ questionMarkers: { particles: [' ka'] } }, /questionMarkers\.particles\[0\] must be trimmed/],
    [{ questionMarkers: { particles: ['ka', 'ka'] } }, /lists an entry twice/],
    [{ questionMarkers: { markers: ['?'] } }, /unknown field "markers"/],
    [{ pronouns: {} }, /pronouns needs at least one part/],
    [{ pronouns: { firstPersonPlural: { inclusive: ['yumi'] } } }, /firstPersonPlural\.clusivity is required/],
    [{ pronouns: { secondPerson: { numberDistinction: 'yes' } } }, /numberDistinction must be true or false/],
    [{ pronouns: { honorifics: { levels: [] } } }, /honorifics\.levels must list 1 to 8 levels/],
    [{ pronouns: { honorifics: { levels: [{ forms: ['tu'] }] } } }, /levels\[0\]\.name is required/],
    [{ negators: 'not' }, /negators must be a list/],
    [{ numberWords: 'spellout' }, /numberWords must be "cldr" or a map/],
    [{ numberWords: { twelve: '12' } }, /not a whole number/],
    [{ speechVerbs: [''] }, /speechVerbs\[0\] must be trimmed text/],
    [{ kinTerms: { notes: 'x' } }, /kinTerms\.relativeAgeDistinction is required/],
    [{ divineNames: {} }, /divineNames needs at least one field/],
    [{ divineNames: { yhwh: '' } }, /divineNames\.yhwh must be text/],
    [{ measures: 'metric' }, /measures must be one of convert, transliterate, mixed/],
    [{ textualVariants: 'drop' }, /textualVariants must be one of omit, bracket, footnote/],
    [{ headings: true }, /headings must be one of none, pericope/],
  ])('rejects %j and names the field', (profile, message) => {
    expect(languageProfileProblem(profile)).toMatch(message)
  })

  it('keeps each valid slot and drops each damaged one on read, independently', () => {
    const stored = { ...FULL, measures: 'metric', pronouns: { honorifics: { levels: [] } } }
    const read = readLanguageProfile(stored)
    expect(read.measures).toBeUndefined()
    expect(read.pronouns).toBeUndefined()
    expect(read.divineNames).toEqual(FULL.divineNames)
    expect(read.questionMarkers).toEqual(FULL.questionMarkers)
    expect(filledLanguageProfileSlots(read)).toEqual(
      new Set(LANGUAGE_PROFILE_SLOTS.filter((slot) => slot !== 'measures' && slot !== 'pronouns')),
    )
  })

  it('reads a copy, so a reader cannot change the stored value', () => {
    const stored = { negators: ['ne'] }
    readLanguageProfile(stored).negators?.push('pas')
    expect(stored.negators).toEqual(['ne'])
  })

  it('documents every slot for describe_command', () => {
    const line = settingsKeyDocLines().find((l) => l.startsWith('languageProfile:'))
    for (const slot of LANGUAGE_PROFILE_SLOTS) expect(line).toContain(`${slot}?:`)
    expect(line).toContain('"cldr"')
  })
})

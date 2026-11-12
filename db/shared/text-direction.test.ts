// AQU-1471 regression guard: the direction resolution ORDER, which three
// surfaces (the editor, the Agent API receipt, the settings registry) have to
// agree on. The order is per-file row → project setting → language, and the two
// ways to get it wrong are the ones tested hardest here: treating "auto" as a
// direction, and letting a project-level setting swallow a per-file override.

import { describe, it, expect } from 'vitest'
import {
  TEXT_DIRECTION_SETTING_VALUES,
  languageDefaultDirection,
  normalizeDirectionMode,
  normalizeTextDirection,
  projectSettingTextDirection,
  resolveProjectTextDirection,
} from './text-direction'
import { validateSettingsKeyValue } from './project-settings-keys'

describe('languageDefaultDirection', () => {
  it('reads RTL off an ISO code or an English language name', () => {
    expect(languageDefaultDirection('ar')).toBe('rtl')
    expect(languageDefaultDirection('arb')).toBe('rtl')
    expect(languageDefaultDirection('Arabic')).toBe('rtl')
    expect(languageDefaultDirection('ar-EG')).toBe('rtl')
    expect(languageDefaultDirection('Hebrew')).toBe('rtl')
    expect(languageDefaultDirection('urd')).toBe('rtl')
  })

  it('defaults an unknown or absent language to ltr', () => {
    expect(languageDefaultDirection('en')).toBe('ltr')
    expect(languageDefaultDirection('Journey Arabicish')).toBe('ltr')
    expect(languageDefaultDirection('')).toBe('ltr')
    expect(languageDefaultDirection(null)).toBe('ltr')
    expect(languageDefaultDirection(undefined)).toBe('ltr')
  })
})

describe('normalizers', () => {
  it('admits only the direction values each shape allows', () => {
    expect(normalizeTextDirection('rtl')).toBe('rtl')
    expect(normalizeTextDirection('auto')).toBeNull()
    expect(normalizeTextDirection('RTL')).toBeNull()
    expect(normalizeTextDirection(undefined)).toBeNull()
    expect(normalizeDirectionMode('auto')).toBe('auto')
    expect(normalizeDirectionMode('ltr')).toBe('ltr')
    expect(normalizeDirectionMode('sideways')).toBeNull()
  })
})

describe('projectSettingTextDirection — the EXPLICIT setting only', () => {
  it('returns the stored direction per side', () => {
    const settings = { sourceTextDirection: 'ltr', targetTextDirection: 'rtl' }
    expect(projectSettingTextDirection(settings, 'source')).toBe('ltr')
    expect(projectSettingTextDirection(settings, 'target')).toBe('rtl')
  })

  it('treats "auto", an absent key and a missing blob alike — no opinion', () => {
    expect(projectSettingTextDirection({ targetTextDirection: 'auto' }, 'target')).toBeNull()
    expect(projectSettingTextDirection({}, 'target')).toBeNull()
    expect(projectSettingTextDirection(null, 'target')).toBeNull()
    expect(projectSettingTextDirection(undefined, 'target')).toBeNull()
  })

  it('ignores a junk value rather than guessing at it', () => {
    expect(projectSettingTextDirection({ targetTextDirection: 'RTL' }, 'target')).toBeNull()
    expect(projectSettingTextDirection({ targetTextDirection: true }, 'target')).toBeNull()
  })
})

describe('resolveProjectTextDirection — setting, then language', () => {
  it('prefers the explicit setting over the language', () => {
    // The point of the key: a project whose target language name Aquilla cannot
    // read ("Journey Arabic") still renders RTL once it is said out loud.
    expect(
      resolveProjectTextDirection({ targetLanguage: 'Journey Arabic', targetTextDirection: 'rtl' }, 'target'),
    ).toBe('rtl')
    // And the reverse: an Arabic-named language a project insists is LTR.
    expect(
      resolveProjectTextDirection({ targetLanguage: 'Arabic', targetTextDirection: 'ltr' }, 'target'),
    ).toBe('ltr')
  })

  it('falls through to the language when the setting is absent or "auto"', () => {
    // The language is the override the caller resolved from the lane, not a
    // settings key (AQU-1595).
    expect(resolveProjectTextDirection({}, 'target', 'Arabic')).toBe('rtl')
    expect(resolveProjectTextDirection({}, 'target', 'ar')).toBe('rtl')
    expect(resolveProjectTextDirection({ targetTextDirection: 'auto' }, 'target', 'Arabic')).toBe('rtl')
    expect(resolveProjectTextDirection({}, 'source', 'en')).toBe('ltr')
    expect(resolveProjectTextDirection({ targetLanguage: 'Arabic' }, 'target')).toBe('ltr')
    expect(resolveProjectTextDirection({ sourceLanguage: 'ar' }, 'source')).toBe('ltr')
  })

  it('lets a per-file language override the project language for that file', () => {
    const settings = { sourceLanguage: 'en', targetLanguage: 'en' }
    expect(resolveProjectTextDirection(settings, 'target', 'he')).toBe('rtl')
    // …but never over the project's explicit setting, which is the project
    // saying "I have already answered this".
    expect(resolveProjectTextDirection({ ...settings, targetTextDirection: 'ltr' }, 'target', 'he')).toBe('ltr')
  })

  it('answers ltr for a project that says nothing at all', () => {
    expect(resolveProjectTextDirection({}, 'target')).toBe('ltr')
    expect(resolveProjectTextDirection(null, 'source')).toBe('ltr')
  })
})

describe('the settings keys are writable through the registry', () => {
  it('accepts every legal direction value on both sides', () => {
    for (const side of ['sourceTextDirection', 'targetTextDirection']) {
      for (const value of TEXT_DIRECTION_SETTING_VALUES) {
        expect(validateSettingsKeyValue(side, value)).toBeNull()
      }
      // null clears a key, as it does for every key in the registry.
      expect(validateSettingsKeyValue(side, null)).toBeNull()
    }
  })

  it('rejects a value outside the enum, naming the legal ones', () => {
    const problem = validateSettingsKeyValue('targetTextDirection', 'right-to-left')
    expect(problem).toContain('targetTextDirection')
    expect(problem).toContain('"rtl"')
  })
})

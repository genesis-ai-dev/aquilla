// AQU-2402 regression guard: the unknown-settings-key refusal has to be
// FOLLOWABLE on its own. It used to say only `call describe_command("PatchSettings")
// for the valid keys` — and that tool is filtered out of the OAuth connector's
// tool list (sync-worker/src/external/mcp-chatgpt-tools.ts), so on the surface
// where a key is most likely to be guessed, the only hint on offer could not be
// followed and every guess cost a round trip. The message now names the keys
// itself, and names the right key when the wrong one is an obvious stand-in —
// above all `builtinChecks`, which is what `get_project_settings` READS the
// built-in checks back as while the write key is `algorithmicChecks`.

import { describe, it, expect } from 'vitest'
import {
  PROJECT_SETTINGS_KEYS,
  SETTINGS_KEY_ALIASES,
  suggestSettingsKey,
  unknownSettingsKeyMessage,
  validateSettingsKeyValue,
} from './project-settings-keys'

describe('unknownSettingsKeyMessage (AQU-2402)', () => {
  it('names every writable key, so the refusal needs no second tool to act on', () => {
    const message = unknownSettingsKeyMessage('bogusKey')
    expect(message).toContain('unknown settings key "bogusKey"')
    for (const key of PROJECT_SETTINGS_KEYS) expect(message).toContain(key)
  })

  it('does not make describe_command the only way out', () => {
    // The pointer may stay for surfaces that HAVE the tool; what must not
    // return is a message whose sole content is "go call that tool".
    const message = unknownSettingsKeyMessage('checks')
    expect(message).toContain('algorithmicChecks')
    expect(message.indexOf('algorithmicChecks')).toBeLessThan(message.indexOf('describe_command'))
  })

  it('points the read name at the write key — builtinChecks → algorithmicChecks', () => {
    expect(unknownSettingsKeyMessage('builtinChecks')).toContain('the key for that is "algorithmicChecks"')
    expect(unknownSettingsKeyMessage('builtinChecksByLane')).toContain(
      'the key for that is "algorithmicChecksByLane"',
    )
  })

  it('is the message validateSettingsKeyValue returns for an unknown key', () => {
    expect(validateSettingsKeyValue('builtinChecks', { 'usfm-structure': { enabled: false } })).toBe(
      unknownSettingsKeyMessage('builtinChecks'),
    )
  })
})

describe('suggestSettingsKey (AQU-2402)', () => {
  it('resolves every declared alias to a key that really is writable', () => {
    for (const [wrong, right] of Object.entries(SETTINGS_KEY_ALIASES)) {
      expect(PROJECT_SETTINGS_KEYS).toContain(right)
      expect(suggestSettingsKey(wrong)).toBe(right)
      // An alias that became a real key would shadow its own suggestion.
      expect(PROJECT_SETTINGS_KEYS).not.toContain(wrong)
    }
  })

  it('folds case and separators onto the real spelling', () => {
    expect(suggestSettingsKey('algorithmic_checks')).toBe('algorithmicChecks')
    expect(suggestSettingsKey('AlgorithmicChecks')).toBe('algorithmicChecks')
    expect(suggestSettingsKey('validation-count')).toBe('validationCount')
  })

  it('stays silent rather than guessing when the probe is ambiguous or unrelated', () => {
    // "validation" prefixes six keys; a wrong pick is worse than the list.
    expect(suggestSettingsKey('validation')).toBeNull()
    expect(suggestSettingsKey('zzz')).toBeNull()
    expect(unknownSettingsKeyMessage('zzz')).not.toContain('the key for that is')
  })
})

// AQU-1692: the `bibleVoiceOverrides` key. Its corrections replace the pack's
// speaker or addressee in every voice chip, rail and "Show every line by …"
// filter, so writers are held to a strict shape while readers stay lenient:
// one bad entry must not take the other corrections, or the editor, down.

import { describe, it, expect } from 'vitest'
import { isBibleVoiceOverrides, readBibleVoiceOverrides } from './bible-voice-overrides'
import { validateSettingsKeyValue } from './project-settings-keys'

const good = { speaker: 'person:Jesus', note: 'FCBH has the disciples here.', by: 'mara', at: '2026-10-06T12:00:00Z' }

describe('isBibleVoiceOverrides (writers)', () => {
  it('accepts a correction of the speaker, the addressee, or both', () => {
    expect(
      isBibleVoiceOverrides({
        'sp:n43004007001-n43004007010': good,
        'sp:n43004009001-n43004009012': { ...good, speaker: undefined, addressee: 'person:Jesus' },
        'sp:o080010160001-o080010170052': { ...good, addressee: 'person:Naomi' },
      }),
    ).toBe(true)
  })

  it('refuses a correction that corrects nothing, or gives no reason or author', () => {
    // A correction with no note cannot be reviewed later; one with no change
    // would mark the speech "Corrected" while showing the pack's reading.
    const { speaker: _speaker, ...noChange } = good
    expect(isBibleVoiceOverrides({ 'sp:a-b': noChange })).toBe(false)
    expect(isBibleVoiceOverrides({ 'sp:a-b': { ...good, note: '  ' } })).toBe(false)
    expect(isBibleVoiceOverrides({ 'sp:a-b': { ...good, by: '' } })).toBe(false)
  })

  it('refuses a key that is not a speech id, and fields it does not know', () => {
    expect(isBibleVoiceOverrides({ 'JHN 4:7': good })).toBe(false)
    expect(isBibleVoiceOverrides({ 'sp:a-b': { ...good, speakerConf: 1 } })).toBe(false)
    expect(isBibleVoiceOverrides([good])).toBe(false)
  })

  it('is what the agent path checks the key against', () => {
    expect(validateSettingsKeyValue('bibleVoiceOverrides', { 'sp:a-b': good })).toBeNull()
    expect(validateSettingsKeyValue('bibleVoiceOverrides', null)).toBeNull()
    expect(validateSettingsKeyValue('bibleVoiceOverrides', { 'sp:a-b': { speaker: 'x' } })).toMatch(
      /bibleVoiceOverrides.*note/,
    )
  })
})

describe('readBibleVoiceOverrides (readers)', () => {
  it('keeps the good corrections and drops a malformed one', () => {
    expect(readBibleVoiceOverrides({ 'sp:a-b': good, 'sp:c-d': { speaker: 'x' }, bogus: good })).toEqual({
      'sp:a-b': good,
    })
  })

  it('reads anything that is not a map as no corrections', () => {
    for (const raw of [undefined, null, 'x', 3, [good]]) expect(readBibleVoiceOverrides(raw)).toEqual({})
  })
})

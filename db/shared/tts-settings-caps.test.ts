// AQU-1943 — the TTS settings ceiling. The numbers are the contract (both
// workers and the SPA refuse by them), so they are asserted at the boundary,
// not near it.
import { describe, it, expect } from 'vitest'
import {
  MAX_TTS_CAST_ASSIGNMENTS,
  MAX_TTS_SETTINGS_BYTES,
  MAX_TTS_VOICES,
  measureTtsSettings,
  ttsSettingsCapProblem,
} from './tts-settings-caps'

const voices = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `v${i}`, name: `Voice ${i}` }))

const assignments = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`c${i}`, 'v0']))

describe('ttsSettingsCapProblem', () => {
  it('passes a library at exactly the cap and refuses the next voice', () => {
    expect(ttsSettingsCapProblem({ voices: voices(MAX_TTS_VOICES) })).toBeNull()
    const over = ttsSettingsCapProblem({ voices: voices(MAX_TTS_VOICES + 1) })
    expect(over?.size.voices).toBe(MAX_TTS_VOICES + 1)
    // The message has to carry both numbers: a person who cannot see how far
    // over they are cannot act on the refusal.
    expect(over?.message).toContain(String(MAX_TTS_VOICES))
    expect(over?.message).toContain(String(MAX_TTS_VOICES + 1))
  })

  it('refuses one cast assignment over the cap, by that count', () => {
    // With realistic (uuid) cell ids the serialized-size cap bites long before
    // this one; it is here so a short-id project cannot slip past on bytes.
    const over = ttsSettingsCapProblem({ castAssignments: assignments(MAX_TTS_CAST_ASSIGNMENTS + 1) })
    expect(over?.message).toContain('castAssignments')
    expect(over?.message).toContain(String(MAX_TTS_CAST_ASSIGNMENTS))
    expect(over?.size.assignments).toBe(MAX_TTS_CAST_ASSIGNMENTS + 1)
    expect(ttsSettingsCapProblem({ castAssignments: assignments(10) })).toBeNull()
  })

  it('refuses one byte over the serialized-size cap', () => {
    const padded = { voices: [{ id: 'v0', name: 'x'.repeat(MAX_TTS_SETTINGS_BYTES) }] }
    const over = ttsSettingsCapProblem(padded)
    expect(over?.message).toContain(String(MAX_TTS_SETTINGS_BYTES))
    expect(over?.size.bytes).toBeGreaterThan(MAX_TTS_SETTINGS_BYTES)
  })

  it('measures a multi-byte name by its UTF-8 bytes, not its characters', () => {
    // "é" is two bytes. A cap counted in characters would let a blob 2× the
    // ceiling through for a non-Latin cast.
    const size = measureTtsSettings({ voices: [{ id: 'v0', name: 'é' }] })
    expect(size.bytes).toBe(JSON.stringify({ voices: [{ id: 'v0', name: 'é' }] }).length + 1)
  })

  it('treats an absent or non-object value as empty', () => {
    expect(ttsSettingsCapProblem(undefined)).toBeNull()
    expect(ttsSettingsCapProblem(null)).toBeNull()
    expect(ttsSettingsCapProblem('voices')).toBeNull()
    expect(measureTtsSettings([])).toEqual({ voices: 0, assignments: 0, bytes: 0 })
  })

  it('ignores a voices/castAssignments value of the wrong shape — that is a shape refusal, not a size one', () => {
    expect(measureTtsSettings({ voices: 'many', castAssignments: [] }))
      .toMatchObject({ voices: 0, assignments: 0 })
  })
})

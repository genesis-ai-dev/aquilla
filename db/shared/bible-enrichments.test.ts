// AQU-1686: the Bible data enrichment registry and the `bibleEnrichments` key.
//
// The registry is read by three consumers that must agree: the settings card
// (what a row shows), the pack client (which layers load) and the server
// (what autopilot may use). These tests pin the rules they share.

import { describe, it, expect } from 'vitest'
import {
  BIBLE_DATA_SOURCE_LICENSES,
  BIBLE_ENRICHMENTS,
  BIBLE_ENRICHMENT_IDS,
  layersForEnrichments,
  readBibleEnrichments,
  resolveBibleEnrichment,
  resolveBibleEnrichments,
  type BibleEnrichmentId,
} from './bible-enrichments'
import { settingsKeyDocLines, validateSettingsKeyValue } from './project-settings-keys'

const allOn = (): Record<BibleEnrichmentId, boolean> =>
  Object.fromEntries(BIBLE_ENRICHMENT_IDS.map((id) => [id, true])) as Record<BibleEnrichmentId, boolean>
const allOff = (): Record<BibleEnrichmentId, boolean> =>
  Object.fromEntries(BIBLE_ENRICHMENT_IDS.map((id) => [id, false])) as Record<BibleEnrichmentId, boolean>

describe('resolveBibleEnrichment', () => {
  // The spec's invariant: when Bible data is off, no enrichment layer loads
  // and no Bible data check runs, whatever each enrichment says.
  it('is false for every id when the Bible data switch is explicitly off', () => {
    const settings = {
      bibleResourcesEnabled: false,
      bibleEnrichments: { voices: true, autopilot: true },
    }
    for (const id of BIBLE_ENRICHMENT_IDS) {
      expect(resolveBibleEnrichment(settings, id, true), id).toBe(false)
    }
  })

  it('is false for every id when the switch is unset and the project has no scripture files', () => {
    for (const id of BIBLE_ENRICHMENT_IDS) {
      expect(resolveBibleEnrichment({ bibleEnrichments: { [id]: true } }, id, false), id).toBe(false)
    }
  })

  it('derives the switch from scripture files when it is unset, as the aquifer gate does', () => {
    expect(resolveBibleEnrichment({}, 'voices', true)).toBe(true)
    expect(resolveBibleEnrichment({ bibleResourcesEnabled: null }, 'voices', true)).toBe(true)
    // An explicit true wins over a project without scripture files.
    expect(resolveBibleEnrichment({ bibleResourcesEnabled: true }, 'voices', false)).toBe(true)
  })

  it('uses an explicit boolean over the default, in both directions', () => {
    const on = { bibleResourcesEnabled: true }
    expect(resolveBibleEnrichment({ ...on, bibleEnrichments: { voices: false } }, 'voices', true)).toBe(false)
    expect(resolveBibleEnrichment({ ...on, bibleEnrichments: { autopilot: true } }, 'autopilot', true)).toBe(true)
  })

  it('uses the registry default when nothing is set for the id', () => {
    const on = { bibleResourcesEnabled: true, bibleEnrichments: { voices: false } }
    for (const id of BIBLE_ENRICHMENT_IDS.filter((i) => i !== 'voices')) {
      expect(resolveBibleEnrichment(on, id, true), id).toBe(BIBLE_ENRICHMENTS[id].default)
    }
  })

  // A hand-edited or legacy blob must not switch anything on by accident.
  it('treats a stored value that is not a boolean as unset', () => {
    const settings = {
      bibleResourcesEnabled: true,
      bibleEnrichments: { autopilot: 'yes' } as unknown as Record<string, boolean>,
    }
    expect(resolveBibleEnrichment(settings, 'autopilot', true)).toBe(false)
  })

  it('resolves every id at once with the same rules', () => {
    expect(resolveBibleEnrichments({ bibleResourcesEnabled: false }, true)).toEqual(allOff())
    const resolved = resolveBibleEnrichments({ bibleEnrichments: { places: false } }, true)
    expect(resolved.places).toBe(false)
    expect(resolved.voices).toBe(true)
    expect(resolved.autopilot).toBe(false)
  })
})

describe('the registry', () => {
  // Autopilot spends model calls on every span. It stays off until its use
  // of Bible data has been evaluated in shadow mode (design §8.1).
  it('defaults every enrichment on except autopilot', () => {
    for (const id of BIBLE_ENRICHMENT_IDS) {
      expect(BIBLE_ENRICHMENTS[id].default, id).toBe(id !== 'autopilot')
    }
  })

  // Turning an enrichment off must stop exactly these files from loading,
  // and the pack client relies on this table to decide what to fetch.
  it('maps each enrichment to the pack layers the spec names', () => {
    const layers = Object.fromEntries(
      BIBLE_ENRICHMENT_IDS.map((id) => [id, [...BIBLE_ENRICHMENTS[id].layers]]),
    )
    expect(layers).toEqual({
      voices: ['voices', 'people'],
      'whos-who': ['people', 'text', 'structure'],
      structure: ['structure'],
      'original-context': ['text', 'people'],
      helps: ['notes'],
      terms: ['terms'],
      places: ['people'],
      checks: ['text', 'structure', 'voices', 'people'],
      autopilot: ['text', 'structure', 'voices', 'people'],
    })
  })

  // The chip must never understate a share-alike obligation: data that mixes
  // in a CC BY-SA source is CC BY-SA.
  it('never gives an enrichment a looser license than one of its sources', () => {
    for (const id of BIBLE_ENRICHMENT_IDS) {
      const { license, sources } = BIBLE_ENRICHMENTS[id]
      expect(sources.length, id).toBeGreaterThan(0)
      if (sources.some((source) => BIBLE_DATA_SOURCE_LICENSES[source] === 'CC BY-SA 4.0')) {
        expect(license, id).toBe('CC BY-SA 4.0')
      }
    }
  })
})

describe('layersForEnrichments', () => {
  it('needs no layer when every enrichment is off', () => {
    expect(layersForEnrichments(allOff())).toEqual([])
  })

  it('loads only the layers of the enabled enrichments, once each', () => {
    expect(layersForEnrichments({ ...allOff(), helps: true })).toEqual(['notes'])
    expect(layersForEnrichments({ ...allOff(), voices: true, places: true })).toEqual(['voices', 'people'])
    expect(layersForEnrichments(allOn())).toEqual(['text', 'structure', 'voices', 'people', 'notes', 'terms'])
  })
})

describe('the bibleEnrichments settings key', () => {
  // Agents write settings through PatchSettings, which validates with this
  // registry. A typo must fail at prepare instead of being stored and ignored.
  it('accepts known ids with boolean values, an empty object, and null to clear', () => {
    expect(validateSettingsKeyValue('bibleEnrichments', { voices: false, autopilot: true })).toBeNull()
    expect(validateSettingsKeyValue('bibleEnrichments', {})).toBeNull()
    expect(validateSettingsKeyValue('bibleEnrichments', null)).toBeNull()
  })

  it('rejects an unknown id', () => {
    expect(validateSettingsKeyValue('bibleEnrichments', { voice: true })).toMatch(/bibleEnrichments/)
  })

  it('rejects a value that is not a boolean', () => {
    expect(validateSettingsKeyValue('bibleEnrichments', { voices: 'off' })).toMatch(/bibleEnrichments/)
    expect(validateSettingsKeyValue('bibleEnrichments', { voices: 0 })).toMatch(/bibleEnrichments/)
    expect(validateSettingsKeyValue('bibleEnrichments', { voices: null })).toMatch(/bibleEnrichments/)
  })

  it('rejects a value that is not a plain object', () => {
    expect(validateSettingsKeyValue('bibleEnrichments', ['voices'])).toMatch(/bibleEnrichments/)
    expect(validateSettingsKeyValue('bibleEnrichments', true)).toMatch(/bibleEnrichments/)
  })

  // describe_command("PatchSettings") renders these lines, so an agent learns
  // the valid ids from the docs instead of by trial and error.
  it('documents every enrichment id', () => {
    const line = settingsKeyDocLines().find((l) => l.startsWith('bibleEnrichments:'))
    expect(line).toBeDefined()
    for (const id of BIBLE_ENRICHMENT_IDS) expect(line).toContain(`"${id}"?: boolean`)
  })

  it('leaves other object keys free-form', () => {
    expect(validateSettingsKeyValue('draftContext', { anything: 'goes' })).toBeNull()
  })
})

describe('readBibleEnrichments', () => {
  it('reads a JSONB object and a JSON string the same way', () => {
    expect(readBibleEnrichments({ voices: false })).toEqual({ voices: false })
    expect(readBibleEnrichments('{"voices":false}')).toEqual({ voices: false })
  })

  it('drops unknown ids and values that are not booleans', () => {
    expect(readBibleEnrichments({ voices: false, nope: true, places: 'no' })).toEqual({ voices: false })
  })

  it('reads anything else as unset', () => {
    expect(readBibleEnrichments(null)).toEqual({})
    expect(readBibleEnrichments(undefined)).toEqual({})
    expect(readBibleEnrichments('not json')).toEqual({})
    expect(readBibleEnrichments(['voices'])).toEqual({})
  })
})

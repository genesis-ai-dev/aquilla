import { describe, expect, it } from 'vitest'
import {
  BLANK_LANE_PLACEHOLDER,
  codeForLanguageLabel,
  planLanesForProject,
  type LaneRolePlan,
} from './backfill-plan'

const targets = (plans: LaneRolePlan[]) => plans.filter((p) => p.role === 'target')
const source = (plans: LaneRolePlan[]) => plans.find((p) => p.role === 'source')!

describe('codeForLanguageLabel', () => {
  it('maps English names to ISO 639-1 codes', () => {
    expect(codeForLanguageLabel('Spanish')).toBe('es')
    expect(codeForLanguageLabel('french')).toBe('fr')
  })
  it('passes through catalog codes', () => {
    expect(codeForLanguageLabel('es')).toBe('es')
  })
  it('returns null for freeform / unknown / empty labels', () => {
    expect(codeForLanguageLabel('Grade 7 English')).toBeNull()
    expect(codeForLanguageLabel('')).toBeNull()
    expect(codeForLanguageLabel(null)).toBeNull()
    expect(codeForLanguageLabel('   ')).toBeNull()
  })
})

describe('planLanesForProject', () => {
  it('clean single-lane project: one source + one default target, no dup from registry', () => {
    const plans = planLanesForProject({
      sourceLanguage: 'English',
      targetLanguage: 'Spanish',
      registryTargetLanes: ['Spanish'],
      dataTargetTags: [''],
    })
    expect(source(plans)).toEqual({
      role: 'source',
      legacyTag: null,
      language: 'English',
      name: 'English',
      langCode: 'en',
    })
    const t = targets(plans)
    expect(t).toHaveLength(1)
    expect(t[0]).toEqual({
      role: 'target',
      legacyTag: '',
      language: 'Spanish',
      name: 'Spanish',
      langCode: 'es',
    })
  })

  it('BLANK project: source falls back, default lane gets placeholder + null code', () => {
    const plans = planLanesForProject({
      sourceLanguage: '',
      targetLanguage: '',
      registryTargetLanes: [],
      dataTargetTags: [''],
    })
    expect(source(plans)).toMatchObject({ name: 'Source', langCode: null })
    const t = targets(plans)
    expect(t).toHaveLength(1)
    expect(t[0]).toEqual({
      role: 'target',
      legacyTag: '',
      // AQU-1592: `language` is the typed label ('' here) — the live writers
      // store only that. `name`/`langCode` stay on the plan for the one-off
      // backfill daemon, which still writes the pre-0140 columns.
      language: '',
      name: BLANK_LANE_PLACEHOLDER,
      langCode: null,
    })
  })

  it('always creates a default lane even when data has no empty tag', () => {
    const plans = planLanesForProject({
      sourceLanguage: 'English',
      targetLanguage: 'Spanish',
      registryTargetLanes: [],
      dataTargetTags: [], // empty project
    })
    const t = targets(plans)
    expect(t).toHaveLength(1)
    expect(t[0].legacyTag).toBe('')
    expect(t[0].name).toBe('Spanish')
  })

  it('multi-lane: default + extra lane present in both data and registry -> one lane each', () => {
    const plans = planLanesForProject({
      sourceLanguage: 'English',
      targetLanguage: 'Spanish',
      registryTargetLanes: ['Spanish', 'French'],
      dataTargetTags: ['', 'French'],
    })
    const t = targets(plans)
    expect(t.map((l) => l.legacyTag)).toEqual(['', 'French'])
    expect(t[1]).toEqual({
      role: 'target',
      legacyTag: 'French',
      language: 'French',
      name: 'French',
      langCode: 'fr',
    })
  })

  it('registry-only lane with no data still becomes an (empty) lane', () => {
    const plans = planLanesForProject({
      sourceLanguage: 'English',
      targetLanguage: 'Spanish',
      registryTargetLanes: ['Spanish', 'German'],
      dataTargetTags: [''],
    })
    const t = targets(plans)
    expect(t.map((l) => l.legacyTag).sort()).toEqual(['', 'German'])
  })

  it('primary registry entry is matched by normalized language, never duplicated', () => {
    const plans = planLanesForProject({
      sourceLanguage: 'English',
      targetLanguage: 'French',
      registryTargetLanes: ['fra'], // same language as 'French'
      dataTargetTags: [''],
    })
    expect(targets(plans)).toHaveLength(1)
    expect(targets(plans)[0].legacyTag).toBe('')
  })

  it('AQU-1532: a regional lane beside its base-language primary gets its own lane', () => {
    const plans = planLanesForProject({
      sourceLanguage: 'English',
      targetLanguage: 'French',
      registryTargetLanes: ['French', 'fr-CA'],
      dataTargetTags: [''],
    })
    expect(targets(plans).map((l) => l.legacyTag)).toEqual(['', 'fr-CA'])
  })

  it('AQU-1532: a code naming the primary still collapses into the default lane', () => {
    const plans = planLanesForProject({
      sourceLanguage: 'English',
      targetLanguage: 'Spanish',
      registryTargetLanes: ['es'],
      dataTargetTags: [''],
    })
    expect(targets(plans).map((l) => l.legacyTag)).toEqual([''])
  })

  it('code-style and freeform data tags are preserved verbatim', () => {
    const plans = planLanesForProject({
      sourceLanguage: 'English',
      targetLanguage: 'Spanish',
      registryTargetLanes: [],
      dataTargetTags: ['', 'fr', 'Grade 7 English'],
    })
    const t = targets(plans)
    expect(t.find((l) => l.legacyTag === 'fr')).toEqual({
      role: 'target',
      legacyTag: 'fr',
      language: 'fr',
      name: 'fr',
      langCode: 'fr',
    })
    expect(t.find((l) => l.legacyTag === 'Grade 7 English')).toMatchObject({
      name: 'Grade 7 English',
      langCode: null,
    })
  })

  it('does not derive a language from a registry tag that is a lane id', () => {
    const plans = planLanesForProject({
      sourceLanguage: 'English',
      targetLanguage: 'Spanish',
      registryTargetLanes: ['a3f09c1e', 'French'],
      dataTargetTags: [''],
    })
    const idLane = targets(plans).find((l) => l.legacyTag === 'a3f09c1e')
    expect(idLane?.language).toBe('')
    expect(targets(plans).find((l) => l.legacyTag === 'French')?.language).toBe('French')
  })

  it('deduplicates repeated data tags', () => {
    const plans = planLanesForProject({
      sourceLanguage: 'English',
      targetLanguage: 'Spanish',
      registryTargetLanes: [],
      dataTargetTags: ['', '', 'French', 'French'],
    })
    expect(targets(plans).map((l) => l.legacyTag)).toEqual(['', 'French'])
  })
})

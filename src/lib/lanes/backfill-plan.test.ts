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
      name: 'English',
      langCode: 'en',
    })
    const t = targets(plans)
    expect(t).toHaveLength(1)
    expect(t[0]).toEqual({
      role: 'target',
      legacyTag: '',
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
      name: 'fr',
      langCode: 'fr',
    })
    expect(t.find((l) => l.legacyTag === 'Grade 7 English')).toMatchObject({
      name: 'Grade 7 English',
      langCode: null,
    })
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

// AQU-1699: agreed names, the input every participant check reads.
//
// WHY: a name check is only as right as the name it expects. A decision the
// project recorded must win over its termbase, the termbase must be matched in
// the language its source terms are in, a rendering the termbase forbids must
// never count as agreed, and a name nothing decides must leave its checks
// dormant rather than guess.

import { describe, expect, it } from 'vitest'
import { factKeyProblem, type ProjectFact } from '../project-facts'
import { JHN_B_PEOPLE, JHN_B_TEXT } from './__fixtures__/pack-b'
import {
  agreedRenderings,
  buildNameTable,
  entityNameFactKey,
  nameFormFactKey,
  packLabelLanguage,
  readinessFromDecisions,
  type AgreedNameInputs,
} from './agreed-names'
import { nameFormKey } from './name-forms'
import type { ConceptInput } from './participant-types'

const fact = (key: string, value: string, scope: ProjectFact['scope'] = {}): ProjectFact => ({
  id: key,
  key,
  value,
  scope,
  author: 'translator',
  at: '2026-10-06T00:00:00.000Z',
})

const concept = (id: string, sourceTerm: string, renderings: [string, string][], extra: Partial<ConceptInput> = {}): ConceptInput => ({
  id,
  sourceTerm,
  status: 'active',
  renderings: renderings.map(([rendering, status]) => ({ rendering, status })),
  ...extra,
})

const inputs = (over: Partial<AgreedNameInputs>): AgreedNameInputs => ({ people: JHN_B_PEOPLE, text: JHN_B_TEXT, sourceLanguage: 'en', ...over })

describe('agreedRenderings: decision, then terminology, then the ACAI link', () => {
  const termbase = [
    concept('k-peter', 'Peter', [
      ['Pedro', 'preferred'],
      ['Simón Pedro', 'admitted'],
      ['Pietro', 'forbidden'],
    ]),
    concept('k-andrew', 'Andrés', [['Andrés', 'preferred']], { externalIds: { acai: 'person:Andrew' } }),
  ]

  it('takes preferred then admitted renderings from the termbase, never a forbidden one', () => {
    expect(agreedRenderings('person:Peter', inputs({ concepts: termbase }))).toEqual({
      entity: 'person:Peter',
      renderings: ['Pedro', 'Simón Pedro'],
      variants: ['Pedro', 'Simón Pedro', 'Pietro'],
      source: 'terminology',
      from: 'k-peter',
    })
  })

  it('lets a decision win over the termbase, and keeps the termbase renderings as known variants', () => {
    const decided = agreedRenderings('person:Peter', inputs({ concepts: termbase, facts: [fact('render.person.Peter', 'Pedro|Cefas')] }))
    expect(decided).toMatchObject({ renderings: ['Pedro', 'Cefas'], source: 'fact', from: 'render.person.Peter' })
    expect(decided?.variants).toEqual(['Pedro', 'Cefas', 'Simón Pedro', 'Pietro'])
  })

  it('falls back to an entry linked by externalIds.acai when no label matches', () => {
    expect(agreedRenderings('person:Andrew', inputs({ concepts: termbase }))).toMatchObject({ renderings: ['Andrés'], source: 'acai' })
  })

  it('has no name for an entity nothing decides, and none from a draft or deprecated entry', () => {
    expect(agreedRenderings('person:Philip', inputs({ concepts: termbase }))).toBeNull()
    const draft = concept('k-philip', 'Philip', [['Felipe', 'preferred']], { status: 'draft' })
    expect(agreedRenderings('person:Philip', inputs({ concepts: [draft] }))).toBeNull()
  })

  it('applies a decision only in its scope', () => {
    const facts = [fact('render.person.Philip', 'Felipe', { passage: { from: 'JHN 1:43', to: 'JHN 1:45' } })]
    expect(agreedRenderings('person:Philip', inputs({ facts }), ['JHN 1:43'])?.renderings).toEqual(['Felipe'])
    expect(agreedRenderings('person:Philip', inputs({ facts }), ['JHN 12:21'])).toBeNull()
  })
})

describe('the termbase is matched in the project\'s SOURCE language', () => {
  const spanish = [concept('k1', 'Pedro', [['Petro', 'preferred']])]

  it('maps the source language to the pack\'s ISO 639-3 label keys', () => {
    expect(['en', 'eng', 'es-419', 'pt-BR', 'sw', 'zh-Hans', 'grc', 'tpi'].map(packLabelLanguage)).toEqual([
      'eng', 'eng', 'spa', 'por', 'swh', 'cmn', 'grc', 'tpi',
    ])
    expect(packLabelLanguage('xyz')).toBeNull()
    // A project that never said: English, as the facts lines always assumed.
    expect(packLabelLanguage(undefined)).toBe('eng')
  })

  it('finds Peter by his Spanish label in a Spanish-source project, and not in an English one', () => {
    expect(agreedRenderings('person:Peter', inputs({ concepts: spanish, sourceLanguage: 'es' }))?.renderings).toEqual(['Petro'])
    expect(agreedRenderings('person:Peter', inputs({ concepts: spanish, sourceLanguage: 'en' }))).toBeNull()
    expect(agreedRenderings('person:Peter', inputs({ concepts: spanish, sourceLanguage: 'xyz' }))).toBeNull()
  })

  it('matches the Greek name itself in a Greek-source project', () => {
    const greek = [concept('k1', 'Κηφᾶς', [['Kefa', 'preferred']])]
    expect(agreedRenderings('person:Peter', inputs({ concepts: greek, sourceLanguage: 'grc' }))?.renderings).toEqual(['Kefa'])
  })

  it('matches a label without ACAI\'s bracketed note, and never names a local entity by its gloss', () => {
    const mary = [concept('k1', 'Mary', [['María', 'preferred']])]
    expect(agreedRenderings('person:Mary.3', inputs({ concepts: mary }))?.renderings).toEqual(['María'])
    const woman = [concept('k2', 'Samaritan woman', [['samaritana', 'preferred']])]
    expect(agreedRenderings('local:JHN:n43004007002', inputs({ concepts: woman }))).toBeNull()
  })
})

describe('several target lanes: an entry names someone only with one rendering', () => {
  it('ignores an entry whose renderings may belong to different lanes', () => {
    const both = [concept('k1', 'Peter', [['Pedro', 'preferred'], ['Pierre', 'preferred']])]
    const one = [concept('k1', 'Peter', [['Pedro', 'preferred'], ['Pietro', 'forbidden']])]
    expect(agreedRenderings('person:Peter', inputs({ concepts: both, multiLane: true }))).toBeNull()
    expect(agreedRenderings('person:Peter', inputs({ concepts: one, multiLane: true }))?.renderings).toEqual(['Pedro'])
    expect(agreedRenderings('person:Peter', inputs({ concepts: both }))?.renderings).toEqual(['Pedro', 'Pierre'])
  })
})

describe('decision keys fit the decision log', () => {
  it('writes an entity id with "." for ":", a form with Latin letters, both valid fact keys', () => {
    expect(entityNameFactKey('person:Jesus.2')).toBe('render.person.Jesus.2')
    expect(nameFormFactKey('person:Peter', 'kephas')).toBe('render.person.Peter.form.kephas')
    expect(factKeyProblem(entityNameFactKey('local:JHN:n43004007002'))).toBeNull()
    expect(factKeyProblem(entityNameFactKey('place:Beth-shan'))).toBeNull()
    expect(factKeyProblem(nameFormFactKey('person:Herod.2', 'herodes'))).toBeNull()
  })

  it('keys each name form by its lemma in Latin letters', () => {
    expect(['Κηφᾶς', 'Σίμων', 'Πέτρος', 'Σαῦλος', 'Ἡρῴδης', 'Ἰησοῦς', 'ἄγγελος', 'Ῥώμη'].map(nameFormKey)).toEqual([
      'kephas', 'simon', 'petros', 'saulos', 'herodes', 'iesous', 'angelos', 'rhome',
    ])
    expect(nameFormKey('שָׁאוּל')).toBe('shvl')
    expect(nameFormKey('·')).toBeNull()
  })
})

describe('readiness', () => {
  it('reads what the decisions and the termbase switch on, without the pack', () => {
    expect(readinessFromDecisions([], [])).toEqual({
      agreedNames: false,
      nameForms: false,
      divineNameFacts: false,
      clusivityFacts: false,
      pronounSpans: false,
    })
    const facts = [
      fact('render.person.Peter.form.kephas', 'Cephas'),
      fact('render.person.Peter.form.petros', 'Peter'),
      fact('render.kyrios-god', 'the LORD'),
      fact('clusivity.ACT.16.10-17', 'exclusive', { passage: { from: 'ACT 16:10', to: 'ACT 16:17' } }),
      fact('render.the-twelve', 'the Twelve'),
    ]
    expect(readinessFromDecisions(facts, [])).toEqual({
      agreedNames: false,
      nameForms: true,
      divineNameFacts: true,
      clusivityFacts: true,
      pronounSpans: false,
    })
    expect(readinessFromDecisions([], [{ status: 'active' }]).agreedNames).toBe(true)
    // A clusivity decision whose value is neither form cannot be enforced.
    expect(readinessFromDecisions([fact('clusivity.ACT.16.10-17', 'it depends')], []).clusivityFacts).toBe(false)
  })

  it('reads the exact readiness off the pack: names the book has', () => {
    const table = buildNameTable(inputs({ facts: [fact('render.person.Moses', 'Moses')] }))
    // Moses is not in these verses: no name the checks could use.
    expect(table.readiness.agreedNames).toBe(false)
    expect(buildNameTable(inputs({ facts: [fact('render.person.Peter', 'Peter')] })).readiness.agreedNames).toBe(true)
  })
})

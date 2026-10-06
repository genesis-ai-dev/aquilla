// AQU-1691: the decision log (`projectFacts`) and how an answer becomes a fact.
//
// WHY: a fact reaches every later draft, so (1) a fact scoped to a passage must
// reach that passage and no other — a stray "we = exclusive" is worse than
// none; (2) an answer for a Language-profile slot must land in the profile, the
// one place a slot lives, while keeping slots this version does not know; (3)
// agents write the log through PatchSettings, so a malformed entry must fail
// at prepare, naming the field; and (4) a save must never delete an entry it
// could not read.

import { describe, expect, it } from 'vitest'
import {
  applyProfileFact,
  decidedFactKeys,
  factAnswerProblem,
  factScopeProblem,
  factsInScope,
  projectFactsProblem,
  readProjectFacts,
  removeProjectFact,
  upsertProjectFact,
  MAX_PROJECT_FACTS,
  type ProjectFact,
} from './project-facts'
import { settingsKeyDocLines, validateSettingsKeyValue } from './project-settings-keys'

function fact(key: string, overrides: Partial<ProjectFact> = {}): ProjectFact {
  return { id: `id-${key}`, key, value: 'v', scope: {}, author: 'ana', at: '2026-10-05T10:00:00.000Z', ...overrides }
}

const everywhere = fact('render.the-twelve', { value: 'the Twelve' })
const inActs16 = fact('clusivity.ACT.16.10-17', {
  value: 'exclusive',
  scope: { passage: { from: 'ACT 16:10', to: 'ACT 16:17' } },
})
const inActs = fact('render.the-way', { value: 'the Way', scope: { book: 'ACT' } })
const aboutAndrew = fact('kin.andrew-peter.relative-age', { value: 'younger', scope: { entity: 'Andrew' } })

describe('factsInScope', () => {
  const facts = [everywhere, inActs16, inActs, aboutAndrew]
  const keys = (refs: string[]) => factsInScope(facts, refs).map((f) => f.key)

  it('gives a span the facts for its passage and book, most specific first, then the project-wide ones', () => {
    expect(keys(['ACT 16:12', 'ACT 16:13'])).toEqual([
      'clusivity.ACT.16.10-17',
      'render.the-way',
      'render.the-twelve',
      'kin.andrew-peter.relative-age',
    ])
  })

  it('leaves out a passage fact outside its verses and a book fact outside its book', () => {
    expect(keys(['ACT 17:1'])).toEqual(['render.the-way', 'render.the-twelve', 'kin.andrew-peter.relative-age'])
    expect(keys(['MRK 1:16'])).toEqual(['render.the-twelve', 'kin.andrew-peter.relative-age'])
  })

  it('matches a passage at its edges and through a bridged cell ref', () => {
    expect(keys(['ACT 16:17'])).toContain('clusivity.ACT.16.10-17')
    expect(keys(['ACT 16:8-10'])).toContain('clusivity.ACT.16.10-17')
    expect(keys(['ACT 16:9'])).not.toContain('clusivity.ACT.16.10-17')
  })

  it('gives a span with no Bible refs only the project-wide facts', () => {
    expect(keys([])).toEqual(['render.the-twelve', 'kin.andrew-peter.relative-age'])
  })

  it('puts the newer of two equally specific facts first', () => {
    const older = fact('a', { at: '2026-01-01T00:00:00.000Z' })
    const newer = fact('b', { at: '2026-02-01T00:00:00.000Z' })
    expect(factsInScope([older, newer], []).map((f) => f.key)).toEqual(['b', 'a'])
  })
})

describe('applyProfileFact', () => {
  it('sets a whole slot, or one field of an object slot, over the stored profile', () => {
    expect(applyProfileFact({ headings: 'none' }, 'measures', 'convert')).toEqual({
      ok: true,
      slot: 'measures',
      profile: { headings: 'none', measures: 'convert' },
    })
    expect(applyProfileFact({ divineNames: { yhwh: 'the LORD' } }, 'divineNames.kyriosJesus', 'Lord')).toMatchObject({
      ok: true,
      profile: { divineNames: { yhwh: 'the LORD', kyriosJesus: 'Lord' } },
    })
  })

  it('reads JSON answers as JSON and other answers as text', () => {
    const applied = applyProfileFact({}, 'pronouns.firstPersonPlural', '{"clusivity":true,"inclusive":["yumi"]}')
    expect(applied).toMatchObject({ ok: true, profile: { pronouns: { firstPersonPlural: { clusivity: true, inclusive: ['yumi'] } } } })
    expect(applyProfileFact({}, 'divineNames.yhwh', 'the LORD')).toMatchObject({ ok: true })
  })

  it('keeps a slot this version does not know', () => {
    const applied = applyProfileFact({ futureSlot: { kept: true } }, 'headings', 'pericope')
    expect(applied).toMatchObject({ ok: true, profile: { futureSlot: { kept: true }, headings: 'pericope' } })
  })

  it('refuses a value the slot cannot hold, a field of a non-object slot, and a deeper path', () => {
    expect(applyProfileFact({}, 'measures', 'metric')).toMatchObject({ ok: false, reason: 'profile-value-invalid' })
    expect(applyProfileFact({ measures: 'convert' }, 'measures.kind', 'x')).toEqual({
      ok: false,
      reason: 'profile-slot-not-an-object',
    })
    expect(applyProfileFact({}, 'pronouns.firstPersonPlural.clusivity', 'true')).toEqual({
      ok: false,
      reason: 'profile-key-too-deep',
    })
  })

  it('checks a field beside the fields its slot already holds', () => {
    // kinTerms needs relativeAgeDistinction: a note alone is not a slot.
    expect(factAnswerProblem('kinTerms.notes', 'kakak / adik', {})).toBe('profile-value-invalid')
    expect(factAnswerProblem('kinTerms.notes', 'kakak / adik', { kinTerms: { relativeAgeDistinction: true } })).toBeNull()
    expect(factAnswerProblem('render.the-twelve', '   ', {})).toBe('answer-empty')
  })
})

describe('the projectFacts setting', () => {
  it('accepts a valid log and null to clear', () => {
    expect(validateSettingsKeyValue('projectFacts', [everywhere, inActs16, inActs, aboutAndrew])).toBeNull()
    expect(validateSettingsKeyValue('projectFacts', null)).toBeNull()
  })

  it.each([
    [[{ ...everywhere, key: 'render the twelve' }], /dot-separated words/],
    [[fact('measures', { value: 'convert' })], /names a Language-profile slot; write it in languageProfile/],
    [[everywhere, { ...everywhere, id: 'other' }], /two facts for "render\.the-twelve"/],
    [[{ ...inActs16, scope: { passage: { from: 'ACT 16:17', to: 'ACT 16:10' } } }], /run forwards within one book/],
    [[{ ...inActs16, scope: { book: 'MRK', passage: { from: 'ACT 16:10', to: 'ACT 16:17' } } }], /different books/],
    [[{ ...everywhere, scope: { book: 'Acts' } }], /USFM book code/],
    [[{ ...everywhere, value: '' }], /value must be text/],
    [[{ ...everywhere, at: 'yesterday' }], /ISO timestamp/],
    [[{ ...everywhere, extra: 1 }], /unknown field "extra"/],
  ])('rejects %j and names the problem', (value, message) => {
    expect(projectFactsProblem(value)).toMatch(message)
    expect(validateSettingsKeyValue('projectFacts', value)).toMatch(/settings key "projectFacts" expects/)
  })

  it('documents the entry shape for describe_command', () => {
    const line = settingsKeyDocLines().find((l) => l.startsWith('projectFacts:'))
    expect(line).toContain('sourceDecisionId?: string')
  })

  it('checks a scope on its own', () => {
    expect(factScopeProblem({})).toBeNull()
    expect(factScopeProblem({ entity: '' })).toMatch(/scope\.entity/)
  })
})

describe('reading and writing the log', () => {
  it('drops a damaged entry on read and keeps the newest entry for a repeated key', () => {
    const newer = { ...everywhere, id: 'n', value: 'the Twelve apostles', at: '2026-10-06T00:00:00.000Z' }
    expect(readProjectFacts([everywhere, { key: 7 }, newer])).toEqual([newer])
    expect(readProjectFacts('not a list')).toEqual([])
  })

  it('replaces the entry for a key, adds a new key, and never deletes an entry it cannot read', () => {
    const unreadable = { key: 'from.a.newer.version', shape: 'unknown' }
    const replaced = upsertProjectFact([unreadable, everywhere], { ...everywhere, id: 'x', value: 'the Twelve apostles' })
    expect(replaced).toEqual({ ok: true, facts: [unreadable, { ...everywhere, id: 'x', value: 'the Twelve apostles' }] })
    const added = upsertProjectFact([unreadable], inActs)
    expect(added).toEqual({ ok: true, facts: [unreadable, inActs] })
    expect(removeProjectFact([unreadable, inActs], inActs.id)).toEqual([unreadable])
  })

  it('refuses a new key once the log is full, but still replaces an existing one', () => {
    const full = Array.from({ length: MAX_PROJECT_FACTS }, (_, i) => fact(`k${i}`))
    expect(upsertProjectFact(full, fact('one-more'))).toEqual({ ok: false, reason: 'too-many-facts' })
    expect(upsertProjectFact(full, fact('k3', { value: 'new' }))).toMatchObject({ ok: true })
  })
})

describe('decidedFactKeys', () => {
  it('lists the log keys, each filled profile slot, and each field of an object slot', () => {
    const keys = decidedFactKeys([everywhere], {
      measures: 'convert',
      divineNames: { yhwh: 'the LORD' },
      headings: 'nonsense',
      futureSlot: { x: 1 },
    })
    expect([...keys].sort()).toEqual(['divineNames', 'divineNames.yhwh', 'measures', 'render.the-twelve'])
  })
})

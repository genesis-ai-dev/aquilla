// AQU-1699: check pack B, pronouns and divine names (P8, P9, X4, P10, P14,
// P15) on real pack data (John, __fixtures__/pack-b.ts). English has one
// "you" and one "we", so the forms are a SYNTHETIC profile in the style of
// Tok Pisin: yu / yupela, yumi (inclusive) / mipela (exclusive), tupela (dual).
//
// WHY: a language that marks the number of "you" or whether "we" includes the
// listener forces the translator to choose, and the Greek and the pack decide
// the choice. Each golden case pins the choice; each planted swap must fire.

import { describe, expect, it } from 'vitest'
import type { LanguageProfile } from '../language-profile'
import type { ProjectFact } from '../project-facts'
import { JHN_B_PEOPLE, JHN_B_STRUCTURE, JHN_B_TEXT, JHN_B_VOICES } from './__fixtures__/pack-b'
import { buildNameTable } from './agreed-names'
import { compileFileExpectations } from './compile'
import { evaluateCell, isBibleCheckDormant } from './evaluate'
import type { PeopleLayerInput } from './participant-types'
import type { BibleCheckFinding, BibleCheckId, CellExpectation } from './types'

const fact = (key: string, value: string, scope: ProjectFact['scope'] = {}): ProjectFact => ({
  id: key,
  key,
  value,
  scope,
  author: 'translator',
  at: '2026-10-06T00:00:00.000Z',
})

function compile(facts: readonly ProjectFact[] = [], people: PeopleLayerInput = JHN_B_PEOPLE) {
  const names = buildNameTable({ people, text: JHN_B_TEXT, facts, sourceLanguage: 'en' })
  const cells = Object.keys(JHN_B_VOICES.verses).map((ref) => ({ id: ref, globalReferences: [ref] }))
  return compileFileExpectations(cells, JHN_B_VOICES, JHN_B_STRUCTURE, JHN_B_TEXT, { people, names })
}

const JHN = compile()
const SYNTHETIC: LanguageProfile = {
  pronouns: {
    secondPerson: { numberDistinction: true, singular: ['yu'], plural: ['yupela'] },
    firstPersonPlural: { clusivity: true, inclusive: ['yumi'], exclusive: ['mipela'] },
    extraNumbers: { dual: true, dualForms: ['tupela'] },
  },
}

function check(
  ref: string,
  text: string,
  code: BibleCheckId,
  profile: LanguageProfile = SYNTHETIC,
  expectations: ReadonlyMap<string, CellExpectation> = JHN,
): BibleCheckFinding[] {
  return evaluateCell(text, expectations.get(ref), profile).filter((f) => f.code === code)
}

describe('P8: "you" has the number the Greek gives it', () => {
  it('reads JHN 4:16 as singular, JHN 4:22 as plural, and JHN 4:21 (both) as mixed', () => {
    expect(JHN.get('JHN 4:16')?.participants?.secondPerson).toEqual({ number: 'singular', explicit: true })
    expect(JHN.get('JHN 4:22')?.participants?.secondPerson).toEqual({ number: 'plural', explicit: true })
    expect(JHN.get('JHN 4:21')?.participants?.secondPerson?.number).toBe('mixed')
  })

  it('flags a singular "you" in JHN 4:22, where Jesus speaks to the Samaritans', () => {
    const right = 'Yupela i lotu long samting yupela i no save long en.'
    expect(check('JHN 4:22', right, 'bkp:P8')).toEqual([])
    const [finding] = check('JHN 4:22', 'Yu i lotu long samting yu i no save long en.', 'bkp:P8')
    expect(finding).toMatchObject({
      reason: 'you-number-wrong',
      params: { number: 'plural' },
      evidence: { kind: 'second-person', refs: ['JHN 4:22'], number: 'plural' },
    })
    expect(finding.spans).toHaveLength(2)
  })

  it('flags JHN 4:16 with no singular "you" at all, and skips a verse with both numbers', () => {
    expect(check('JHN 4:16', 'Jisas i tokim em, "Go singautim man bilong yu."', 'bkp:P8')).toEqual([])
    expect(check('JHN 4:16', 'Jisas i tokim em, "Go singautim man."', 'bkp:P8')[0]?.reason).toBe('you-number-missing')
    expect(check('JHN 4:21', 'yu yupela', 'bkp:P8')).toEqual([])
  })

  it('is dormant for a language with one "you", and without the forms', () => {
    const english = { pronouns: { secondPerson: { numberDistinction: false } } }
    expect(isBibleCheckDormant('bkp:P8', english)).toBe(true)
    expect(check('JHN 4:22', 'Yu i lotu.', 'bkp:P8', english)).toEqual([])
    expect(isBibleCheckDormant('bkp:P8', { pronouns: { secondPerson: { numberDistinction: true, singular: ['yu'] } } })).toBe(true)
  })
})

describe('P9: inclusive or exclusive "we"', () => {
  it('decides JHN 4:22 exclusive: "we" is Jesus and the Jews, the people spoken to are the Samaritan woman and the Samaritans', () => {
    const decided = JHN.get('JHN 4:22')?.participants?.firstPlural.filter((m) => m.clusivity !== null) ?? []
    expect(decided.map((m) => m.clusivity)).toEqual(['exclusive', 'exclusive'])
    expect(decided[0]?.referents).toEqual(expect.arrayContaining(['group:Jews', 'person:Jesus.2']))
    expect(decided[0]?.addressees).toEqual(expect.arrayContaining(['local:JHN:n43004007002', 'group:Samaritan']))
  })

  it('flags the inclusive "we" in JHN 4:22, and passes the exclusive one', () => {
    expect(check('JHN 4:22', 'Mipela i lotu long samting mipela i save long en.', 'bkp:P9')).toEqual([])
    const [finding] = check('JHN 4:22', 'Yumi i lotu long samting yumi i save long en.', 'bkp:P9')
    expect(finding).toMatchObject({ reason: 'clusivity-wrong', params: { clusivity: 'exclusive' } })
    expect(finding.evidence).toMatchObject({ kind: 'clusivity', referents: expect.arrayContaining(['Jews', 'Jesus']) })
  })

  it('turns inclusive when the people spoken to belong to "we"', () => {
    // The same verse, with the Samaritan woman among "we": now "we" includes the listener.
    const grp = 'grp:JHN:n43004022006'
    const entities = JHN_B_PEOPLE.entities as Record<string, (typeof JHN_B_PEOPLE.entities)[keyof typeof JHN_B_PEOPLE.entities]>
    const withHer: PeopleLayerInput = {
      ...JHN_B_PEOPLE,
      entities: { ...entities, [grp]: { ...entities[grp], members: ['person:Jesus.2', 'local:JHN:n43004007002', 'group:Samaritan'] } },
    }
    const inclusive = compile([], withHer)
    expect(inclusive.get('JHN 4:22')?.participants?.firstPlural.filter((m) => m.clusivity).map((m) => m.clusivity)).toEqual([
      'inclusive',
      'inclusive',
    ])
    expect(check('JHN 4:22', 'Mipela i lotu.', 'bkp:P9', SYNTHETIC, inclusive)[0]?.reason).toBe('clusivity-wrong')
  })

  it('skips a "we" the data cannot decide, and is dormant for a language without clusivity', () => {
    // JHN 20:2 "we don't know": no referent in the pack.
    expect(JHN.get('JHN 20:2')?.participants?.firstPlural.map((m) => m.clusivity)).toEqual([null])
    expect(check('JHN 20:2', 'Yumi no save.', 'bkp:P9')).toEqual([])
    expect(isBibleCheckDormant('bkp:P9', { pronouns: { firstPersonPlural: { clusivity: false } } })).toBe(true)
  })
})

describe('X4: a recorded decision about "we" holds over the inference', () => {
  const decision = fact('clusivity.JHN.4.22', 'inclusive', { passage: { from: 'JHN 4:22', to: 'JHN 4:22' } })
  const decided = compile([decision])

  it('enforces the decided form in its passage, and P9 stands down there', () => {
    const [finding] = check('JHN 4:22', 'Mipela i lotu long samting mipela i save long en.', 'bkp:X4', SYNTHETIC, decided)
    expect(finding).toMatchObject({
      reason: 'clusivity-wrong',
      params: { clusivity: 'inclusive', decision: 'clusivity.JHN.4.22' },
      evidence: { kind: 'decision', key: 'clusivity.JHN.4.22' },
    })
    expect(check('JHN 4:22', 'Mipela i lotu.', 'bkp:P9', SYNTHETIC, decided)).toEqual([])
    expect(check('JHN 4:22', 'Yumi i lotu long samting yumi i save long en.', 'bkp:X4', SYNTHETIC, decided)).toEqual([])
  })

  it('applies only in its scope, and is dormant without a decision or without the forms', () => {
    expect(check('JHN 4:20', 'Ol tumbuna bilong yumi i lotu.', 'bkp:X4', SYNTHETIC, decided)).toEqual([])
    expect(isBibleCheckDormant('bkp:X4', SYNTHETIC, JHN.get('JHN 4:22')?.participants?.names.readiness)).toBe(true)
    expect(isBibleCheckDormant('bkp:X4', {}, decided.get('JHN 4:22')?.participants?.names.readiness)).toBe(true)
  })
})

describe('P10: dual, trial and paucal', () => {
  it('flags JHN 12:22 without the dual: "they told Jesus" is Andrew and Philip', () => {
    expect(JHN.get('JHN 12:22')?.participants?.groups.map((g) => [g.entity, g.size])).toEqual([['grp:JHN:n43012022013', 2]])
    expect(check('JHN 12:22', 'Tupela i tokim Jisas.', 'bkp:P10')).toEqual([])
    const [finding] = check('JHN 12:22', 'Ol i tokim Jisas.', 'bkp:P10')
    expect(finding).toMatchObject({ reason: 'group-number-missing', params: { number: 'dual', size: '2' } })
  })

  it('is dormant without dual, trial or paucal forms, and says when the language has none', () => {
    expect(isBibleCheckDormant('bkp:P10', {})).toBe(true)
    expect(isBibleCheckDormant('bkp:P10', { pronouns: { extraNumbers: { dual: false, trial: false, paucal: false } } })).toBe(true)
  })
})

describe('P14: κύριος and πνεῦμα', () => {
  const lordAndLORD: LanguageProfile = { divineNames: { kyriosJesus: 'Lord', kyriosGod: 'LORD' } }
  const WEB_11_2 = 'It was that Mary who had anointed the Lord with ointment and wiped his feet with her hair, whose brother Lazarus was sick.'

  it('reads κύριος in JHN 11:2 as Jesus, and leaves out the vocative κύριε ("Sir") of JHN 4:15', () => {
    expect(JHN.get('JHN 11:2')?.participants?.divine.map((d) => d.kind)).toEqual(['kyrios-jesus'])
    expect(JHN.get('JHN 4:15')?.participants?.divine).toEqual([])
  })

  it('passes "the Lord" for Jesus, and flags the rendering kept for God, case and all', () => {
    expect(check('JHN 11:2', WEB_11_2, 'bkp:P14', lordAndLORD)).toEqual([])
    const [finding] = check('JHN 11:2', WEB_11_2.replace('the Lord', 'the LORD'), 'bkp:P14', lordAndLORD)
    expect(finding).toMatchObject({ reason: 'divine-name-swapped', params: { divine: 'kyrios-jesus', rendering: 'Lord', found: 'LORD' } })
  })

  it('takes a decision over the profile, and checks the Holy Spirit by decision only', () => {
    const decided = compile([fact('render.kyrios-jesus', 'Master'), fact('render.holy-spirit', 'Holy Spirit')])
    expect(check('JHN 11:2', WEB_11_2, 'bkp:P14', lordAndLORD, decided)[0]).toMatchObject({
      reason: 'divine-name-missing',
      params: { rendering: 'Master' },
    })
    const WEB_14_26 = 'But the Counselor, the Holy Spirit, whom the Father will send in my name, will teach you all things.'
    expect(check('JHN 14:26', WEB_14_26, 'bkp:P14', {}, decided)).toEqual([])
    expect(check('JHN 14:26', WEB_14_26.replace('Holy Spirit', 'Holy Ghost'), 'bkp:P14', {}, decided)[0]).toMatchObject({
      reason: 'divine-name-missing',
      params: { divine: 'holy-spirit' },
    })
  })

  it('is dormant with no rendering of κύριος anywhere', () => {
    expect(isBibleCheckDormant('bkp:P14', {}, JHN.get('JHN 11:2')?.participants?.names.readiness)).toBe(true)
  })
})

describe('P15: capitals for God need each pronoun\'s place', () => {
  const capitals: LanguageProfile = { divineNames: { deityPronounCapitalization: true } }

  it('stays dormant without a word alignment, even with the house style set', () => {
    expect(isBibleCheckDormant('bkp:P15', capitals, JHN.get('JHN 4:16')?.participants?.names.readiness)).toBe(true)
    expect(check('JHN 4:16', 'Jesus said to her, "Go."', 'bkp:P15', capitals)).toEqual([])
  })

  it('flags a lowercase pronoun once an alignment places it', () => {
    const expectation = JHN.get('JHN 11:2')
    if (!expectation?.participants) throw new Error('no participants')
    const text = 'It was that Mary who anointed the Lord and wiped his feet.'
    const start = text.indexOf('his')
    const aligned: CellExpectation = {
      ...expectation,
      participants: {
        ...expectation.participants,
        names: { ...expectation.participants.names, readiness: { ...expectation.participants.names.readiness, pronounSpans: true } },
        deityPronounSpans: [{ start, end: start + 3 }],
      },
    }
    const [finding] = evaluateCell(text, aligned, capitals).filter((f) => f.code === 'bkp:P15')
    expect(finding).toMatchObject({ reason: 'deity-pronoun-lowercase', spans: [{ start, end: start + 3 }] })
    expect(evaluateCell(text.replace('his', 'His'), aligned, capitals).filter((f) => f.code === 'bkp:P15')).toEqual([])
  })
})

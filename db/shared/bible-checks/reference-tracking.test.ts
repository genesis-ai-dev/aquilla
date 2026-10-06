// AQU-1701: who a reader must be able to track — the pack facts behind the
// P11 (introduction) and P13 (referent) Jev questions, on real pack data
// (John, __fixtures__/pack-b.ts) with the pack's real pericope boundaries.
//
// WHY: Jev is asked only where the pack says a reader could lose track, and a
// question asked where nothing can go wrong costs a call and invites a false
// "no". P11 asks about a participant only at the first mention after a
// pericope boundary, and only where the Greek names them there: someone who
// carries on from the last pericope as "he" needs no introduction. P13 asks
// only when another active participant could be mistaken for the implied
// subject: two men in a verse, not a man and a woman.

import { describe, expect, it } from 'vitest'
import { JHN_B_PEOPLE, JHN_B_SEGMENTS, JHN_B_STRUCTURE, JHN_B_TEXT_GLOSSED, JHN_B_VOICES } from './__fixtures__/pack-b'
import { buildNameTable } from './agreed-names'
import { compileFileExpectations } from './compile'
import type { CellParticipants, PeopleLayerInput } from './participant-types'
import { ambiguousSubjectsIn, type MentionEntry } from './reference-tracking'
import type { TextLayerInput } from './types'

function participantsOf(ref: string, opts: { segments?: typeof JHN_B_SEGMENTS; text?: TextLayerInput | null } = {}): CellParticipants {
  // The glossed text: the questions name the verb, as the full text layer gives it.
  const text = opts.text === undefined ? JHN_B_TEXT_GLOSSED : opts.text
  const names = buildNameTable({ people: JHN_B_PEOPLE, text, sourceLanguage: 'en' })
  // The pack's pericopes here: "The First Disciples of Jesus" (1:35–42), "Jesus Calls Philip and Nathaniel" (1:43–51)…
  const structure = { ...JHN_B_STRUCTURE, segments: opts.segments ?? JHN_B_SEGMENTS }
  const cells = Object.keys(JHN_B_VOICES.verses).map((r) => ({ id: r, globalReferences: [r] }))
  const participants = compileFileExpectations(cells, JHN_B_VOICES, structure, text, { people: JHN_B_PEOPLE, names }).get(ref)?.participants
  if (!participants) throw new Error(`no participants for ${ref}`)
  return participants
}

describe('P11: the first mention after a pericope boundary, where the Greek names them', () => {
  it('JHN 1:43 starts a pericope: Philip is named there for the first time; Jesus carries on as the verb\'s subject', () => {
    // ἠθέλησεν ("he decided") is Jesus' first mention in 1:43–51: no introduction is due.
    expect(participantsOf('JHN 1:43').introduced).toEqual([{ entity: 'person:Philip', word: 'n43001043010' }])
  })

  it('JHN 1:42 introduces only the participant new to the pericope (Simon\'s father John), not Jesus or Peter, named again', () => {
    expect(participantsOf('JHN 1:42').introduced).toEqual([{ entity: 'person:John.4', word: 'n43001042016' }])
  })

  it('introduces nobody without the pericope boundaries, or without the text layer that says which words are names', () => {
    expect(participantsOf('JHN 1:43', { segments: [] }).introduced).toEqual([])
    expect(participantsOf('JHN 1:43', { text: null }).introduced).toEqual([])
  })
})

describe('P13: an implied subject that another active participant could be mistaken for', () => {
  it('JHN 1:42 "he brought him": Andrew is the implied subject among Jesus, Simon and his brother — all men', () => {
    const [subject] = participantsOf('JHN 1:42').ambiguousSubjects
    expect(subject).toMatchObject({ entity: 'person:Andrew', word: 'n43001042001', gloss: 'brought' })
    expect(subject.peers).toEqual(expect.arrayContaining(['person:Jesus.2', 'person:Peter']))
  })

  it('JHN 4:16 "he said to her": a man and a woman cannot be mistaken for each other, so nothing is asked', () => {
    expect(participantsOf('JHN 4:16').ambiguousSubjects).toEqual([])
  })

  it('JHN 1:43 names Jesus, so his implied subjects are not ambiguous', () => {
    expect(participantsOf('JHN 1:43').ambiguousSubjects).toEqual([])
  })

  it('asks nothing without the text layer, which says the verb is third person and gives its gloss', () => {
    expect(participantsOf('JHN 1:42', { text: null }).ambiguousSubjects).toEqual([])
  })
})

// WHY: the pack labels some participants with the gloss of a pronoun (τις →
// "anyone"), and a question naming one is nonsense ("Is it clear in this
// translation that the anyone is the one who be?"). JHN 9:22, as the pack has it.
describe('P13: only a participant a question can name', () => {
  const ANYONE = 'local:JHN:n43009022017'
  const people = (label: string): PeopleLayerInput => ({
    entities: {
      [ANYONE]: { type: 'local-person', gender: 'masculine', labels: { eng: label } },
      'person:Jesus.2': { type: 'person', gender: 'male', labels: { eng: 'Jesus' } },
    },
    mentions: {},
  })
  const text: TextLayerInput = {
    verses: { 'JHN 9:22': ['n43009022017', 'n43009022018', 'n43009022022'] },
    words: { n43009022022: { lemma: 'γίνομαι', english: 'be', class: 'verb', person: 'third', number: 'singular' } },
  }
  const mentions: MentionEntry[] = [
    ['n43009022017', { entity: ANYONE, kind: 'pronoun', conf: 0.9 }],
    ['n43009022018', { entity: 'person:Jesus.2', kind: 'pronoun', conf: 0.97 }],
    ['n43009022022', { entity: ANYONE, kind: 'subject', conf: 0.8 }],
  ]

  it('asks nothing about "anyone", and would about "the man" in the same place', () => {
    expect(ambiguousSubjectsIn(mentions, people('anyone'), text, [])).toEqual([])
    expect(ambiguousSubjectsIn(mentions, people('man'), text, []).map((s) => s.entity)).toEqual([ANYONE])
  })
})

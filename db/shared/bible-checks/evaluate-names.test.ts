// AQU-1699: check pack B, names (P1, P3, P4, P5, P6) on real pack data (John,
// trimmed in __fixtures__/pack-b.ts) and real target text (World English
// Bible, public domain).
//
// WHY: "if the source verse refers to A, the translation names A, and names
// nobody the source does not have". A wrong name makes the verse say that
// someone else did it. Each golden case pins what the source requires; each
// planted error is one the check must catch (design doc §10).

import { describe, expect, it } from 'vitest'
import type { ProjectFact } from '../project-facts'
import { JHN_B_PEOPLE, JHN_B_STRUCTURE, JHN_B_TEXT, JHN_B_VOICES } from './__fixtures__/pack-b'
import { buildNameTable } from './agreed-names'
import { compileFileExpectations } from './compile'
import { evaluateCell, isBibleCheckDormant } from './evaluate'
import type { BibleCheckFinding, BibleCheckId } from './types'

const fact = (key: string, value: string, scope: ProjectFact['scope'] = {}): ProjectFact => ({
  id: key,
  key,
  value,
  scope,
  author: 'translator',
  at: '2026-10-06T00:00:00.000Z',
})

/** What an English project would decide for the people of these verses. */
const NAMES = [
  fact('render.person.Jesus.2', 'Jesus|Christ|Messiah'),
  fact('render.person.Peter', 'Peter|Simon|Cephas'),
  fact('render.person.John', 'John'),
  fact('render.person.Andrew', 'Andrew'),
  fact('render.person.Philip', 'Philip'),
  // WEB reads Ἰωάννου in 1:42 as "Jonah".
  fact('render.person.John.4', 'Jonah'),
  fact('render.person.Marymagdalene', 'Mary Magdalene'),
  fact('render.person.Mary.3', 'Mary of Bethany|Mary'),
]

function compile(facts: readonly ProjectFact[]) {
  const names = buildNameTable({ people: JHN_B_PEOPLE, text: JHN_B_TEXT, facts, sourceLanguage: 'en' })
  const cells = Object.keys(JHN_B_VOICES.verses).map((ref) => ({ id: ref, globalReferences: [ref] }))
  return compileFileExpectations(cells, JHN_B_VOICES, JHN_B_STRUCTURE, JHN_B_TEXT, { people: JHN_B_PEOPLE, names })
}

const JHN = compile(NAMES)
const PROFILE = { questionMarkers: {} }

function check(ref: string, text: string, code: BibleCheckId, expectations = JHN): BibleCheckFinding[] {
  return evaluateCell(text, expectations.get(ref), PROFILE).filter((f) => f.code === code)
}

const names = (ref: string, text: string, expectations = JHN) =>
  evaluateCell(text, expectations.get(ref), PROFILE)
    .filter((f) => ['bkp:P1', 'bkp:P3', 'bkp:P4', 'bkp:P5', 'bkp:P6'].includes(f.code))
    .map((f) => f.code)

// World English Bible (public domain).
const WEB_1_40 = 'One of the two who heard John and followed him was Andrew, Simon Peter’s brother.'
const WEB_1_42 =
  'He brought him to Jesus. Jesus looked at him and said, “You are Simon the son of Jonah. You shall be called Cephas” (which is by interpretation, Peter).'
const WEB_4_16 = 'Jesus said to her, “Go, call your husband, and come here.”'
const WEB_4_17 = 'The woman answered, “I have no husband.” Jesus said to her, “You said well, ‘I have no husband,’'
const WEB_20_1 =
  'Now on the first day of the week, Mary Magdalene went early, while it was still dark, to the tomb, and saw that the stone had been taken away from the tomb.'

describe('the published text passes', () => {
  it('has no name findings in JHN 1:40, 1:42, 4:16, 4:17 and 20:1', () => {
    expect(names('JHN 1:40', WEB_1_40)).toEqual([])
    expect(names('JHN 1:42', WEB_1_42)).toEqual([])
    expect(names('JHN 4:16', WEB_4_16)).toEqual([])
    expect(names('JHN 4:17', WEB_4_17)).toEqual([])
    expect(names('JHN 20:1', WEB_20_1)).toEqual([])
  })
})

describe('P5: the translation names nobody the source does not have', () => {
  it('flags JHN 1:42 when "John" stands for Simon: no John is in the verse, so it is major', () => {
    const [finding] = check('JHN 1:42', WEB_1_42.replace('You are Simon', 'You are John'), 'bkp:P5')
    expect(finding).toMatchObject({
      reason: 'name-not-in-source',
      severity: 'warning',
      params: { name: 'John (the Baptist)', found: 'John' },
      evidence: { kind: 'no-mention', refs: ['JHN 1:42'], entity: 'person:John' },
    })
    expect(finding.spans).toHaveLength(1)
  })

  it('lets the source mention a person in any way: by name, as a pronoun or as a verb subject', () => {
    // 1:42 names Simon (Σίμων, Κηφᾶς, Πέτρος): "Peter" is his.
    expect(check('JHN 1:42', WEB_1_42, 'bkp:P5')).toEqual([])
    // 4:16 only implies Jesus (Λέγει): "Jesus said" is his.
    expect(check('JHN 4:16', WEB_4_16, 'bkp:P5')).toEqual([])
  })

  it('lets a namesake the project has not named explain the shared name ("son of John" for Peter\'s father)', () => {
    const undecided = compile(NAMES.filter((f) => f.key !== 'render.person.John.4'))
    const sonOfJohn = WEB_1_42.replace('son of Jonah', 'son of John')
    expect(names('JHN 1:42', sonOfJohn, undecided)).toEqual([])
    // Once the project names him "Jonah", "John" is a namesake's name (the Baptist's): P3, not P5.
    expect(names('JHN 1:42', sonOfJohn)).toEqual(['bkp:P3'])
    expect(check('JHN 1:42', sonOfJohn, 'bkp:P3')[0]?.params).toMatchObject({ name: 'John', rendering: 'Jonah', found: 'John' })
  })

  it('reports a place or group the source lacks at info, not major', () => {
    const withPlaces = compile([...NAMES, fact('render.place.Galilee', 'Galilee')])
    const [finding] = check('JHN 4:17', `${WEB_4_17} (in Galilee)`, 'bkp:P5', withPlaces)
    expect(finding).toMatchObject({ severity: 'info', params: { found: 'Galilee', person: 'false' } })
  })
})

describe('P6: a name for the implied subject is that person\'s', () => {
  it('flags JHN 4:16 "Peter said": Λέγει implies Jesus, the verse names nobody, so it is major', () => {
    const planted = WEB_4_16.replace('Jesus said', 'Peter said')
    const [finding] = check('JHN 4:16', planted, 'bkp:P6')
    expect(finding).toMatchObject({
      reason: 'subject-name-wrong',
      severity: 'warning',
      params: { name: 'Jesus', rendering: 'Jesus', found: 'Peter', nameSource: 'fact', nameFrom: 'render.person.Jesus.2' },
      evidence: { kind: 'mention', refs: ['JHN 4:16'], entity: 'person:Jesus.2', word: 1, mention: 'subject' },
    })
    // One wrong name, one finding: P5 leaves it to P6.
    expect(check('JHN 4:16', planted, 'bkp:P5')).toEqual([])
  })

  it('leaves a verse that names people to P5: a stray name there is a wrong name, not an inserted subject', () => {
    const planted = WEB_1_42.replace('You are Simon', 'You are John')
    expect(check('JHN 1:42', planted, 'bkp:P6')).toEqual([])
    expect(check('JHN 1:42', planted, 'bkp:P5')).toHaveLength(1)
  })
})

describe('P1: a name the source uses has its agreed rendering', () => {
  it('flags JHN 1:40 when Andrew is dropped, with the decision as evidence', () => {
    const [finding] = check('JHN 1:40', WEB_1_40.replace('was Andrew,', 'was'), 'bkp:P1')
    expect(finding).toMatchObject({
      reason: 'name-missing',
      params: { name: 'Andrew', rendering: 'Andrew', renderings: 'Andrew', nameSource: 'fact', nameFrom: 'render.person.Andrew' },
      evidence: { kind: 'mention', refs: ['JHN 1:40'], entity: 'person:Andrew', mention: 'explicit' },
    })
  })

  it('says a pronoun can be right where the context names the person (Jesus speaks in 1:42)', () => {
    const [finding] = check('JHN 1:42', WEB_1_42.replace('to Jesus. Jesus looked', 'to him. He looked'), 'bkp:P1')
    expect(finding).toMatchObject({ severity: 'info', params: { name: 'Jesus', pronounOk: 'true' } })
  })

  it('accepts an inflected name: up to three letters of affix', () => {
    expect(check('JHN 1:40', WEB_1_40.replace('Andrew', 'Andrewnya'), 'bkp:P1')).toEqual([])
    expect(check('JHN 1:40', WEB_1_40.replace('Andrew', 'Andrewlicious'), 'bkp:P1')).toHaveLength(1)
  })

  it('is dormant for a name nobody has agreed: no decision, no terminology', () => {
    const none = compile([])
    expect(none.get('JHN 1:40')?.participants?.names.readiness.agreedNames).toBe(false)
    expect(isBibleCheckDormant('bkp:P1', PROFILE, none.get('JHN 1:40')?.participants?.names.readiness)).toBe(true)
    expect(check('JHN 1:40', WEB_1_40.replace('was Andrew,', 'was'), 'bkp:P1', none)).toEqual([])
    // Only Andrew decided: the others' names stay unchecked.
    const andrewOnly = compile([fact('render.person.Andrew', 'Andrew')])
    expect(check('JHN 1:40', 'One of the two who heard him and followed him was Andrew, his brother.', 'bkp:P1', andrewOnly)).toEqual([])
  })
})

describe('P3: namesakes are told apart', () => {
  it('flags Mary of Bethany where JHN 20:1 names Mary Magdalene, once', () => {
    const planted = WEB_20_1.replace('Mary Magdalene', 'Mary of Bethany')
    const [finding] = check('JHN 20:1', planted, 'bkp:P3')
    expect(finding).toMatchObject({
      reason: 'homonym-name',
      params: { name: 'Mary Magdalene', rendering: 'Mary Magdalene', found: 'Mary of Bethany', other: 'Mary (of Bethany)' },
      evidence: { kind: 'mention', entity: 'person:Marymagdalene' },
    })
    expect(names('JHN 20:1', planted)).toEqual(['bkp:P3'])
  })

  it('cannot tell namesakes apart when the project names them alike', () => {
    const alike = compile([fact('render.person.Marymagdalene', 'Mary'), fact('render.person.Mary.3', 'Mary')])
    expect(names('JHN 20:1', WEB_20_1.replace('Mary Magdalene', 'Mary'), alike)).toEqual([])
  })
})

describe('P4: the name form the source uses', () => {
  const FORMS = [
    ...NAMES,
    fact('render.person.Peter.form.simon', 'Simon'),
    fact('render.person.Peter.form.kephas', 'Cephas'),
    fact('render.person.Peter.form.petros', 'Peter'),
  ]
  const withForms = compile(FORMS)

  it('passes JHN 1:42, which renders Σίμων, Κηφᾶς and Πέτρος each as decided', () => {
    expect(check('JHN 1:42', WEB_1_42, 'bkp:P4', withForms)).toEqual([])
  })

  it('flags "Peter" where the source says Κηφᾶς', () => {
    const [finding] = check('JHN 1:42', WEB_1_42.replace('called Cephas', 'called Peter'), 'bkp:P4', withForms)
    expect(finding).toMatchObject({ reason: 'name-form-missing', params: { form: 'Κηφᾶς', rendering: 'Cephas', name: 'Peter' } })
  })

  it('is dormant without a decision for two forms of one name', () => {
    expect(JHN.get('JHN 1:42')?.participants?.names.readiness.nameForms).toBe(false)
    expect(check('JHN 1:42', WEB_1_42.replace('called Cephas', 'called Peter'), 'bkp:P4')).toEqual([])
  })
})

describe('decisions apply in their scope', () => {
  it('uses a decision for one book only in that book', () => {
    const elsewhere = compile([fact('render.person.Andrew', 'Andreas', { book: 'MRK' })])
    expect(check('JHN 1:40', WEB_1_40.replace('was Andrew,', 'was'), 'bkp:P1', elsewhere)).toEqual([])
    const here = compile([fact('render.person.Andrew', 'Andreas', { book: 'JHN' })])
    expect(check('JHN 1:40', WEB_1_40, 'bkp:P1', here)[0]?.params.rendering).toBe('Andreas')
  })
})

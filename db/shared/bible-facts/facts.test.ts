// AQU-1690: per-cell Bible facts on JHN 4:7–10 (real pack data, trimmed).
//
// These facts go into autopilot's construe and draft prompts as GIVEN facts,
// so the model never has to guess who is speaking. Each test names the fact a
// translator relies on, and fails if the pack reading behind it breaks.

import { describe, expect, it } from 'vitest'
import { compileFileExpectations } from '../bible-checks/compile'
import { JHN4_STRUCTURE, JHN4_VOICES } from '../bible-checks/__fixtures__/pack'
import { JHN4_PEOPLE, JHN4_TEXT } from './__fixtures__/jhn4-people'
import { computeCellFacts, MAX_FACTS_LINE_CHARS, renderFactsLine } from './facts'
import type { CellFacts, FactsLayers } from './types'

const layers: FactsLayers = { voices: JHN4_VOICES, structure: JHN4_STRUCTURE, people: JHN4_PEOPLE, text: JHN4_TEXT }
const JESUS = 'person:Jesus.2'
const WOMAN = 'local:JHN:n43004007002'

function factsFor(refs: string[], over: Partial<FactsLayers> = {}, renderings?: Map<string, string>): CellFacts {
  const cells = refs.map((ref) => ({ id: ref, globalReferences: [ref] }))
  const expectation = compileFileExpectations(cells, JHN4_VOICES, JHN4_STRUCTURE).get(refs[refs.length - 1])
  if (!expectation) throw new Error(`no expectation for ${refs.join(', ')}`)
  return computeCellFacts(expectation, { ...layers, ...over }, renderings)
}

const ids = (entities: readonly { id: string }[]) => entities.map((entity) => entity.id)

describe('computeCellFacts — JHN 4:7–10', () => {
  it('4:7 Jesus asks the woman for a drink: one level-1 quotation that opens and closes, "you" singular', () => {
    const facts = factsFor(['JHN 4:7'])
    expect(facts.speeches).toHaveLength(1)
    expect(facts.speeches[0]).toMatchObject({
      speaker: { id: JESUS, label: 'Jesus' },
      addressee: { id: WOMAN, label: 'Samaritan woman' },
      level: 1,
      opens: true,
      closes: true,
    })
    // Samaria is a place, not a participant.
    expect(ids(facts.participants)).toEqual([WOMAN, JESUS])
    expect(facts.secondPerson).toBe('singular')
    expect(facts.question).toBe(false)
  })

  it('4:8 is narration only: the disciples are named, Jesus only by a pronoun', () => {
    const facts = factsFor(['JHN 4:8'])
    expect(facts.speeches).toEqual([])
    expect(ids(facts.participants)).toEqual(['local:JHN:n43004008003'])
    expect(facts.secondPerson).toBeNull()
  })

  it('4:9 the woman asks Jesus a question, the quotation closes before the narrator\'s aside, and the aside is negated', () => {
    const facts = factsFor(['JHN 4:7', 'JHN 4:8', 'JHN 4:9'])
    expect(facts.speeches[0]).toMatchObject({ speaker: { id: WOMAN }, addressee: { id: JESUS }, opens: true, closes: true })
    expect(facts.trailingText).toEqual({ closeLevel: 1, endLevel: 0 })
    expect(facts.question).toBe(true)
    expect(facts.negators).toBe(1)
    // "being a Jew" implies Jesus as subject; the cell never names him.
    expect(ids(facts.impliedSubjects)).toEqual([JESUS])
    expect(facts.secondPerson).toBe('singular')
  })

  it('4:10 Jesus quotes his own request inside his reply: a level-2 quotation inside the level-1 one', () => {
    const facts = factsFor(['JHN 4:10'])
    expect(facts.speeches.map((s) => [s.speaker?.id, s.addressee?.id, s.level, s.opens, s.closes])).toEqual([
      [JESUS, WOMAN, 1, true, true],
      [JESUS, WOMAN, 2, true, true],
    ])
    // After the inner quote closes, Jesus' reply goes on: level-1 speech, not narration.
    expect(facts.trailingText).toEqual({ closeLevel: 2, endLevel: 1 })
    // "water" is a neuter local "person" in the pack, and θεός is the LORD deity: neither is a participant.
    expect(ids(facts.participants)).toEqual([JESUS])
    expect(ids(facts.impliedSubjects)).toEqual([WOMAN])
  })

  it('leaves second-person number out when the text layer is not loaded', () => {
    expect(factsFor(['JHN 4:7'], { text: null }).secondPerson).toBeNull()
  })

  it('uses the project\'s agreed rendering of a name when the caller found one', () => {
    const facts = factsFor(['JHN 4:7'], {}, new Map([[JESUS, 'Yesu']]))
    expect(facts.speeches[0].speaker).toEqual({ id: JESUS, label: 'Jesus', rendering: 'Yesu' })
  })
})

describe('renderFactsLine', () => {
  it('draft line: speaker → addressee with entity ids and where each quote opens and closes, 4:7–4:10', () => {
    const lines = ['JHN 4:7', 'JHN 4:8', 'JHN 4:9', 'JHN 4:10'].map((ref) => renderFactsLine(factsFor([ref]), 'draft'))
    expect(lines[0]).toContain(`Jesus [${JESUS}] → Samaritan woman [${WOMAN}], quote level 1 opens and closes here`)
    expect(lines[0]).toContain('"you" is singular')
    expect(lines[1]).toContain('narration only')
    expect(lines[2]).toContain(`Samaritan woman [${WOMAN}] → Jesus [${JESUS}], quote level 1 opens and closes here`)
    expect(lines[2]).toContain('narration follows after the level-1 quote closes')
    expect(lines[2]).toContain('the source asks a question')
    expect(lines[3]).toContain('quote level 2 opens and closes here')
    expect(lines[3]).toContain('level-1 speech continues after the level-2 quote closes')
    expect(lines[3]).not.toContain('narration')
  })

  it('construe line: who speaks to whom and who is named, without ids or quote levels', () => {
    const line = renderFactsLine(factsFor(['JHN 4:9']), 'construe')
    expect(line).toBe('speech Samaritan woman → Jesus; named: Samaritan woman, Samaritans, Jews; implied subject: Jesus')
  })

  it('stays within its ceiling', () => {
    const facts = factsFor(['JHN 4:10'])
    const long = { ...facts, participants: Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, label: 'x'.repeat(40) })) }
    expect(renderFactsLine(long, 'draft').length).toBeLessThanOrEqual(MAX_FACTS_LINE_CHARS)
  })
})

// AQU-1699: the file-level scans of check pack B — one name across the file
// (P2) and one rendering for a repeated quotation (X3).
//
// WHY: a reader meets Peter in many verses; if one verse calls him something
// else, they meet a stranger. And a quotation the source repeats word for word
// should be recognisable as the same words in the translation.

import { describe, expect, it } from 'vitest'
import type { ProjectFact } from '../project-facts'
import { JHN_B_PEOPLE, JHN_B_STRUCTURE, JHN_B_TEXT, JHN_B_VOICES } from './__fixtures__/pack-b'
import { buildNameTable } from './agreed-names'
import { compileFileExpectations } from './compile'
import { scanNameConsistency, scanRepeatedQuotations, type TextScanCell } from './scans-pack-b'
import type { SpeechInput, TextLayerInput } from './types'

const fact = (key: string, value: string): ProjectFact => ({
  id: key,
  key,
  value,
  scope: {},
  author: 'translator',
  at: '2026-10-06T00:00:00.000Z',
})

describe('P2: one name across the file', () => {
  const names = buildNameTable({
    people: JHN_B_PEOPLE,
    text: JHN_B_TEXT,
    facts: [fact('render.person.Peter', 'Peter|Simon Peter|Cephas')],
    sourceLanguage: 'en',
  })
  // Four cells of JHN 20:2, which names Σίμων Πέτρος, and one of 1:42, which also has Κηφᾶς.
  const cells: TextScanCell[] = [
    { id: 'a', globalReferences: ['JHN 20:2'], text: 'She ran to Simon Peter.' },
    { id: 'b', globalReferences: ['JHN 20:2'], text: 'She came to Simon Peter.' },
    { id: 'c', globalReferences: ['JHN 20:2'], text: 'She ran to Peter.' },
    { id: 'd', globalReferences: ['JHN 20:2'], text: 'She ran to the fisherman.' },
    { id: 'e', globalReferences: ['JHN 1:42'], text: 'You shall be called Cephas.' },
  ]
  const expectations = compileFileExpectations(cells, JHN_B_VOICES, JHN_B_STRUCTURE, JHN_B_TEXT, { people: JHN_B_PEOPLE, names })

  it('reports the cell that renders the same Greek name another way, and the one with none of its names', () => {
    const findings = scanNameConsistency(cells, expectations)
    expect(findings.map((f) => [f.cellId, f.reason, f.params])).toEqual([
      ['c', 'name-variant-different', { name: 'Peter', found: 'Peter', usual: 'Simon Peter' }],
      ['d', 'name-variant-none', { name: 'Peter', usual: 'Simon Peter' }],
    ])
    expect(findings[0]).toMatchObject({ code: 'bkp:P2', evidence: { kind: 'name-variants', entity: 'person:Peter' } })
  })

  it('compares a cell only with cells that use the same form of the name: Κηφᾶς is not Σίμων Πέτρος', () => {
    expect(scanNameConsistency(cells, expectations).some((f) => f.cellId === 'e')).toBe(false)
  })

  it('has nothing to compare without agreed names', () => {
    const none = buildNameTable({ people: JHN_B_PEOPLE, text: JHN_B_TEXT, facts: [], sourceLanguage: 'en' })
    const bare = compileFileExpectations(cells, JHN_B_VOICES, JHN_B_STRUCTURE, JHN_B_TEXT, { people: JHN_B_PEOPLE, names: none })
    expect(scanNameConsistency(cells, bare)).toEqual([])
  })
})

describe('X3: a repeated quotation is rendered alike', () => {
  // The same four Greek words quoted in JHN 1:1 and 1:2 (synthetic), and three in 1:3.
  const words = ['Δός', 'μοι', 'πιεῖν', 'σήμερον']
  const text: TextLayerInput = {
    verses: {
      'JHN 1:1': words.map((_, i) => `n4300100100${i + 1}`),
      'JHN 1:2': words.map((_, i) => `n4300100200${i + 1}`),
      'JHN 1:3': words.slice(0, 3).map((_, i) => `n4300100300${i + 1}`),
    },
    words: Object.fromEntries(
      ['001', '002', '003'].flatMap((verse) => words.map((w, i) => [`n43001${verse}00${i + 1}`, { text: w }])),
    ),
  }
  const speech = (verse: string, length: number): SpeechInput => ({
    id: `sp:${verse}`,
    from: `n43001${verse}001`,
    to: `n43001${verse}00${length}`,
    depth: 2,
    level: 1,
    parent: null,
    selfProjected: false,
    speakerConf: 1,
    speakerSources: [],
  })
  const voices = { speeches: [speech('001', 4), speech('002', 4), speech('003', 3)] }
  const profile = { quoteMarks: { levels: [{ open: '“', close: '”' }], continuation: 'none' as const } }
  const cell = (id: string, ref: string, t: string): TextScanCell => ({ id, globalReferences: [ref], text: t })

  it('passes the repetition rendered alike, inside a longer verse', () => {
    const cells = [
      cell('x', 'JHN 1:1', 'He said, “Give me a drink today.”'),
      cell('y', 'JHN 1:2', 'Later, by the well, she remembered: “Give me a drink today.”'),
    ]
    expect(scanRepeatedQuotations(cells, voices, text, profile)).toEqual([])
  })

  it('flags the later cell when the same words come out differently', () => {
    const cells = [cell('x', 'JHN 1:1', 'He said, “Give me a drink today.”'), cell('y', 'JHN 1:2', 'She heard, “Water, now!”')]
    const [finding] = scanRepeatedQuotations(cells, voices, text, profile)
    expect(finding).toMatchObject({
      cellId: 'y',
      code: 'bkp:X3',
      reason: 'quotation-differs',
      params: { other: 'JHN 1:1' },
      evidence: { kind: 'repeated-quotation', refs: ['JHN 1:2'], other: 'JHN 1:1' },
    })
    expect(Number(finding.params.similarity)).toBeLessThan(0.5)
  })

  it('leaves a quotation shorter than four words alone', () => {
    const cells = [cell('x', 'JHN 1:1', '“Give me a drink today.”'), cell('z', 'JHN 1:3', '“Water, now!”')]
    expect(scanRepeatedQuotations(cells, voices, text, profile)).toEqual([])
  })
})

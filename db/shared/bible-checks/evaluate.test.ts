// AQU-1688: Bible data quotation checks and the question check, on real pack
// data (JHN 4, MAT 5 and MAT 14:8, trimmed in __fixtures__/pack.ts) and real
// target text (World English Bible, public domain).
//
// WHY: a translator must be told when a quotation is left open, closed in the
// wrong place, nested with the wrong marks, or invented where nobody speaks,
// and when a question loses its question mark. Each golden case pins what the
// source facts require of a correct translation; each mutation is a seeded
// error the check must catch (design doc §10: "a test that must fail if the
// check stops catching it").

import { describe, it, expect } from 'vitest'
import { compileFileExpectations } from './compile'
import { evaluateCell } from './evaluate'
import { JHN4_STRUCTURE, JHN4_VOICES, MAT_STRUCTURE, MAT_VOICES } from './__fixtures__/pack'
import type { LanguageProfile } from '../language-profile'
import type { BibleCheckFinding } from './types'

const ENGLISH: LanguageProfile = {
  quoteMarks: {
    levels: [
      { open: '“', close: '”' },
      { open: '‘', close: '’' },
      { open: '“', close: '”' },
    ],
    continuation: 'reopen-each-paragraph',
  },
}

const cellsFor = (refs: string[]) => refs.map((ref) => ({ id: ref, globalReferences: [ref] }))
const JHN = compileFileExpectations(
  cellsFor(Array.from({ length: 15 }, (_, i) => `JHN 4:${i + 1}`)),
  JHN4_VOICES,
  JHN4_STRUCTURE,
)
const MAT = compileFileExpectations(
  cellsFor([...Array.from({ length: 12 }, (_, i) => `MAT 5:${i + 17}`), 'MAT 14:8']),
  MAT_VOICES,
  MAT_STRUCTURE,
)

// World English Bible (public domain).
const WEB: Record<string, string> = {
  'JHN 4:7': 'A woman of Samaria came to draw water. Jesus said to her, “Give me a drink.”',
  'JHN 4:8': 'For his disciples had gone away into the city to buy food.',
  'JHN 4:9':
    'The Samaritan woman therefore said to him, “How is it that you, being a Jew, ask for a drink from me, a Samaritan woman?” (For Jews have no dealings with Samaritans.)',
  'JHN 4:10':
    'Jesus answered her, “If you knew the gift of God, and who it is who says to you, ‘Give me a drink,’ you would have asked him, and he would have given you living water.”',
  'JHN 4:11':
    'The woman said to him, “Sir, you have nothing to draw with, and the well is deep. So where do you get that living water?',
  'JHN 4:12':
    'Are you greater than our father Jacob, who gave us the well and drank from it himself, as did his children and his livestock?”',
  'JHN 4:13': 'Jesus answered her, “Everyone who drinks of this water will thirst again,',
  'JHN 4:14':
    'but whoever drinks of the water that I will give him will never thirst again; but the water that I will give him will become in him a well of water springing up to eternal life.”',
  'MAT 5:21':
    '“You have heard that it was said to the ancient ones, ‘You shall not murder;’ and ‘Whoever murders will be in danger of the judgment.’',
  'MAT 5:22':
    'But I tell you that everyone who is angry with his brother without a cause will be in danger of the judgment. Whoever says to his brother, ‘Raca!’ will be in danger of the council. Whoever says, ‘You fool!’ will be in danger of the fire of Gehenna.',
  'MAT 5:27': '“You have heard that it was said, ‘You shall not commit adultery;’',
  'MAT 5:28':
    'but I tell you that everyone who gazes at a woman to lust after her has committed adultery with her already in his heart.',
  'MAT 14:8': 'She, being prompted by her mother, said, “Give me here on a platter the head of John the Baptizer.”',
}

function check(ref: string, text: string, profile: LanguageProfile = ENGLISH): BibleCheckFinding[] {
  const expectation = (ref.startsWith('JHN') ? JHN : MAT).get(ref)
  expect(expectation, `${ref} has an expectation`).toBeDefined()
  return evaluateCell(text, expectation, profile)
}

const codes = (findings: BibleCheckFinding[]) => findings.map((f) => f.code)

describe('golden: a correct English translation (WEB) passes every check', () => {
  // MAT 14:8 is left out: WEB merges its interrupted quotation, which the V8 test covers.
  it.each(Object.keys(WEB).filter((ref) => ref !== 'MAT 14:8'))('%s', (ref) => {
    expect(check(ref, WEB[ref])).toEqual([])
  })
})

describe('golden: what the source facts require', () => {
  it('4:7 needs “…” around words 12–14 (Δός μοι πεῖν), opened and closed in the verse', () => {
    const [speech] = JHN.get('JHN 4:7')!.speeches
    expect(speech).toMatchObject({ from: 'n43004007012', to: 'n43004007014', level: 1, opens: true, closes: true })
    const unquoted = check('JHN 4:7', 'A woman of Samaria came to draw water. Jesus said to her, Give me a drink.')
    expect(unquoted[0]).toMatchObject({
      code: 'bkp:V1',
      reason: 'open-missing',
      evidence: { kind: 'speech', startRef: 'JHN 4:7', startWord: 12, endRef: 'JHN 4:7', endWord: 14 },
    })
  })

  it('4:9 needs the quotation closed before the narrator’s aside', () => {
    const moved = WEB['JHN 4:9'].replace('woman?” (For', 'woman? (For').replace('Samaritans.)', 'Samaritans.)”')
    const [finding] = check('JHN 4:9', moved)
    expect(finding).toMatchObject({
      code: 'bkp:V2',
      reason: 'close-after-aside',
      severity: 'warning',
      // The story's evidence line: OpenText speech JHN 4:9 words 8–18.
      evidence: { kind: 'speech', startRef: 'JHN 4:9', startWord: 8, endRef: 'JHN 4:9', endWord: 18 },
    })
    expect(moved.slice(finding.spans[0].start, finding.spans[0].end)).toBe('”')
  })

  it('4:10 needs ‘…’ (level 2) nested inside “…” (level 1)', () => {
    const levels = JHN.get('JHN 4:10')!.speeches.map((s) => [s.level, s.opens, s.closes])
    expect(levels).toEqual([[1, true, true], [2, true, true]])
    // Dropping the inner quotation altogether is a missing level-2 open.
    const flat = WEB['JHN 4:10'].replace('‘Give me a drink,’', 'give me a drink,')
    expect(check('JHN 4:10', flat)[0]).toMatchObject({ code: 'bkp:V1', params: { level: '2' } })
  })

  it('4:8 needs no marks: nobody speaks in it', () => {
    expect(JHN.get('JHN 4:8')!.speeches).toEqual([])
    expect(check('JHN 4:8', WEB['JHN 4:8'])).toEqual([])
  })

  it('4:9 needs a question mark: the Greek ends the question with ;', () => {
    expect(JHN.get('JHN 4:9')!.question.expected).toBe(true)
    expect(JHN.get('JHN 4:7')!.question.expected).toBe(false)
  })
})

describe('mutations: each seeded error is caught', () => {
  it('deleting the closing ” in 4:9 fires V2', () => {
    const findings = check('JHN 4:9', WEB['JHN 4:9'].replace('woman?”', 'woman?'))
    expect(codes(findings)).toEqual(['bkp:V2'])
    expect(findings[0]).toMatchObject({ reason: 'close-missing', params: { level: '1', expected: '1', found: '0' } })
  })

  it('adding quotation marks in 4:8 fires V7 (info)', () => {
    const findings = check('JHN 4:8', '“For his disciples had gone away into the city to buy food.”')
    expect(codes(findings)).toEqual(['bkp:V7'])
    expect(findings[0]).toMatchObject({ severity: 'info', evidence: { kind: 'no-speech', refs: ['JHN 4:8'] } })
    expect(findings[0].spans).toHaveLength(2)
  })

  it('using “ instead of ‘ for the inner quotation of 4:10 fires V5', () => {
    const findings = check('JHN 4:10', WEB['JHN 4:10'].replace('‘Give', '“Give').replace('drink,’', 'drink,”'))
    expect(codes(findings)).toEqual(['bkp:V5'])
    expect(findings[0]).toMatchObject({ params: { level: '2', open: '‘', close: '’' } })
  })

  it('removing the ? in 4:9 fires M1 (warning: no rhetorical-question note yet)', () => {
    const findings = check('JHN 4:9', WEB['JHN 4:9'].replace('woman?”', 'woman.”'))
    expect(codes(findings)).toEqual(['bkp:M1'])
    expect(findings[0]).toMatchObject({ severity: 'warning', evidence: { kind: 'question', refs: ['JHN 4:9'] } })
  })

  it('closing a quotation that continues into the next verse fires V3', () => {
    // Jesus' answer runs from 4:13 into 4:14, so 4:13 must not close it.
    const findings = check('JHN 4:13', WEB['JHN 4:13'].replace('again,', 'again.”'))
    expect(codes(findings)).toEqual(['bkp:V3'])
  })

  it('a self-projected “I tell you that …” given its own quotation marks fires V9 (MAT 5:28)', () => {
    const findings = check('MAT 5:28', 'but I tell you, ‘Everyone who gazes at a woman to lust after her has committed adultery with her already in his heart.’')
    expect(codes(findings)).toEqual(['bkp:V9'])
    expect(findings[0]).toMatchObject({ severity: 'info', params: { level: '2' } })
  })

  it('an interrupted quotation rendered as one quotation fires V8 (info) — MAT 14:8, “Give me,” she says, “…”', () => {
    expect(MAT.get('MAT 14:8')!.speeches[0]).toMatchObject({ interruptCloses: 1, interruptOpens: 1 })
    expect(check('MAT 14:8', WEB['MAT 14:8']).map((f) => [f.code, f.severity])).toEqual([['bkp:V8', 'info']])
    const interrupted = '“Give me,” she said, prompted by her mother, “here on a platter the head of John the Baptizer.”'
    expect(check('MAT 14:8', interrupted)).toEqual([])
  })
})

describe('conventions that are not errors', () => {
  it('a paragraph inside a speech may reopen with “ (English continuation), and is not a new quotation', () => {
    // MAT 5:21 and 5:27 sit inside the Sermon on the Mount; WEB starts each with “.
    expect(MAT.get('MAT 5:27')!.startDepth).toBe(1)
    expect(check('MAT 5:27', WEB['MAT 5:27'])).toEqual([])
  })

  it('a self-projected speech keeps its level: “I tell you that …” needs no marks of its own', () => {
    const selfProjected = MAT.get('MAT 5:28')!.speeches.find((s) => s.selfProjected)!
    expect(selfProjected.level).toBe(1)
    expect(check('MAT 5:28', WEB['MAT 5:28'])).toEqual([])
  })

  it('scare quotes or a short title in a cell with no speech are allowed', () => {
    expect(check('JHN 4:8', 'For his disciples had gone away into the “city” to buy food.')).toEqual([])
  })

  it('apostrophes are not quotation marks', () => {
    expect(check('JHN 4:8', 'For the disciples’ errand they’d gone away into the city to buy food.')).toEqual([])
  })
})

describe('dormancy: no findings while a check cannot know the project’s marks', () => {
  const mutations: [string, string][] = [
    ['JHN 4:9', WEB['JHN 4:9'].replace('woman?”', 'woman.')],
    ['JHN 4:8', '“For his disciples had gone away into the city to buy food.”'],
    ['JHN 4:10', WEB['JHN 4:10'].replace('‘Give', '“Give')],
  ]

  it.each([
    ['no Language profile', null],
    ['a profile without quotation marks', {}],
  ])('%s → zero findings, even for broken text', (_label, profile) => {
    for (const [ref, text] of mutations) expect(evaluateCell(text, JHN.get(ref), profile)).toEqual([])
  })

  it('no expectation (a verse the pack lacks) → zero findings', () => {
    expect(evaluateCell('“anything', undefined, ENGLISH)).toEqual([])
  })
})

describe('purity: a cell is checked from its own text and pack facts only', () => {
  it('compiling reads each cell’s id and refs, never any text', () => {
    const textFields = new Set(['value', 'text', 'original', 'translated', 'translatedHtml', 'originalHtml'])
    const cells = cellsFor(['JHN 4:9', 'JHN 4:10']).map(
      (cell) =>
        new Proxy(cell, {
          get(target, prop, receiver) {
            if (typeof prop === 'string' && textFields.has(prop)) throw new Error(`compile read ${prop}`)
            return Reflect.get(target, prop, receiver)
          },
        }),
    )
    expect(() => compileFileExpectations(cells, JHN4_VOICES, JHN4_STRUCTURE)).not.toThrow()
  })

  it('takes exactly one text: the cell’s own', () => {
    expect(evaluateCell.length).toBe(3)
    const before = check('JHN 4:9', WEB['JHN 4:9'].replace('woman?”', 'woman?'))
    // Checking every other cell, with any text, changes nothing for 4:9.
    for (const ref of Object.keys(WEB)) check(ref, '“broken')
    expect(check('JHN 4:9', WEB['JHN 4:9'].replace('woman?”', 'woman?'))).toEqual(before)
  })
})

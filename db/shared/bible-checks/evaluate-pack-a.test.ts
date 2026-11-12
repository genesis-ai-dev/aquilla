// AQU-1697: check pack A per cell — numbers (N1, N2), negation (M3), a
// sentence that runs on into the next verse (S3) and verses some manuscripts
// leave out (S6, S7) — on real pack data (John, trimmed in
// __fixtures__/pack-a.ts; Matthew from __fixtures__/pack.ts) and real target
// text (World English Bible, public domain).
//
// WHY: a dropped number or a dropped "not" changes what the Bible says, and a
// project's policy for doubtful verses must hold in every verse. Each golden
// case pins what the source facts require of a correct translation; each
// mutation is a seeded error the check must catch (design doc §10: "a test
// that must fail if the check stops catching it").

import { describe, expect, it } from 'vitest'
import type { LanguageProfile } from '../language-profile'
import { JHN_A_STRUCTURE, JHN_A_TEXT, JHN_A_VOICES } from './__fixtures__/pack-a'
import { MAT_STRUCTURE, MAT_VOICES } from './__fixtures__/pack'
import { compileFileExpectations } from './compile'
import { evaluateCell, isBibleCheckDormant } from './evaluate'
import type { BibleCheckFinding, BibleCheckId } from './types'

const ENGLISH: LanguageProfile = {
  questionMarkers: {},
  negators: ['not', 'no', 'never', 'nothing', 'none', 'neither', 'nor', 'unless', "doesn't", "don't", "didn't", "wasn't"],
  numberWords: {
    '3': 'three',
    '5': 'five',
    '6': 'six',
    '40': 'forty',
    '50': 'fifty',
    '100': 'hundred',
    '1000': 'thousand',
  },
  textualVariants: 'bracket',
}

const cellsFor = (refs: readonly string[]) => refs.map((ref) => ({ id: ref, globalReferences: [ref] }))
const JHN = compileFileExpectations(cellsFor(Object.keys(JHN_A_VOICES.verses)), JHN_A_VOICES, JHN_A_STRUCTURE, JHN_A_TEXT)

function check(ref: string, text: string, code: BibleCheckId, profile: LanguageProfile = ENGLISH): BibleCheckFinding[] {
  return evaluateCell(text, JHN.get(ref), profile).filter((f) => f.code === code)
}

// World English Bible (public domain).
const WEB_21_11 =
  'Simon Peter went up, and drew the net to land, full of one hundred fifty-three great fish. Even though there were so many, the net wasn’t torn.'
const WEB_3_18 =
  'He who believes in him is not judged. He who doesn’t believe has been judged already, because he has not believed in the name of the only born Son of God.'

describe('N1: a number the source states stays in the translation', () => {
  it('reads JHN 21:11 as 153 from three Greek words, though only two are Macula class "num"', () => {
    const numbers = JHN.get('JHN 21:11')?.numbers ?? []
    expect(numbers.map((n) => [n.kind, n.value, n.parts])).toEqual([['cardinal', 153, [100, 50, 3]]])
  })

  it('passes 153 as digits, as number words, and in Devanagari digits', () => {
    expect(check('JHN 21:11', WEB_21_11, 'bkp:N1')).toEqual([])
    expect(check('JHN 21:11', WEB_21_11.replace('one hundred fifty-three', '153'), 'bkp:N1')).toEqual([])
    expect(check('JHN 21:11', 'शमौन पतरस ने जाल को किनारे पर खींचा, जो १५३ बड़ी मछलियों से भरा था।', 'bkp:N1')).toEqual([])
  })

  it('flags JHN 21:11 when the number is gone, with Macula as evidence', () => {
    const [finding] = check('JHN 21:11', WEB_21_11.replace('one hundred fifty-three ', ''), 'bkp:N1')
    expect(finding).toMatchObject({
      reason: 'number-missing',
      params: { value: '153', accepts: 'digits-or-words' },
      evidence: { kind: 'number', refs: ['JHN 21:11'], startWord: 15, endWord: 17 },
    })
  })

  it('reads digits only with standard (CLDR) number words, and says so', () => {
    const cldr = { ...ENGLISH, numberWords: 'cldr' as const }
    expect(check('JHN 21:11', WEB_21_11.replace('one hundred fifty-three', '153'), 'bkp:N1', cldr)).toEqual([])
    expect(check('JHN 21:11', WEB_21_11, 'bkp:N1', cldr)[0]?.params.accepts).toBe('digits')
  })

  it('tells a project whose number words lack the number to add it', () => {
    const fewWords = { ...ENGLISH, numberWords: { '12': 'twelve' } }
    expect(check('JHN 21:11', WEB_21_11, 'bkp:N1', fewWords)[0]?.params.accepts).toBe('digits-unlisted-word')
  })

  it('joins number words that καί links: τεσσεράκοντα καὶ ἓξ is 46 (JHN 2:20)', () => {
    expect(JHN.get('JHN 2:20')?.numbers.map((n) => n.value)).toEqual([46, 3])
    const web = 'The Jews therefore said, “It took forty-six years to build this temple! Will you raise it up in three days?”'
    expect(check('JHN 2:20', web, 'bkp:N1')).toEqual([])
    expect(check('JHN 2:20', web.replace('forty-six', 'many'), 'bkp:N1')[0]?.params.value).toBe('46')
  })

  it('keeps an approximate number ("about five thousand", ὡς) as an info hint', () => {
    const web = 'Jesus said, “Have the people sit down.” Now there was much grass in that place. So the men sat down, in number about five thousand.'
    expect(check('JHN 6:10', web, 'bkp:N1')).toEqual([])
    const [finding] = check('JHN 6:10', web.replace(', in number about five thousand', ''), 'bkp:N1')
    expect(finding).toMatchObject({ severity: 'info', params: { value: '5000', about: 'true' } })
  })

  it('treats a lone εἷς as "a" or "a certain" (info), and one that means "first" as no number at all', () => {
    // JHN 1:3 οὐδὲ ἕν: "nothing" — εἷς glossed "one", which a translation need not say.
    const [finding] = check('JHN 1:3', 'All things were made through him. Without him, nothing was made that has been made.', 'bkp:N1')
    expect(finding).toMatchObject({ severity: 'info', params: { value: '1', indefinite: 'true' } })
    // JHN 20:1 μιᾷ τῶν σαββάτων: "the first day of the week" is not a count.
    expect(JHN.get('JHN 20:1')?.numbers).toEqual([])
  })
})

describe('N2: an ordinal stays, where the translation writes numbers in digits', () => {
  const web = 'The third day, there was a wedding in Cana of Galilee. Jesus’ mother was there.'

  it('cannot tell a kept "third" from a dropped one in a cell without digits, so it says nothing', () => {
    expect(check('JHN 2:1', web, 'bkp:N2')).toEqual([])
    expect(check('JHN 2:1', web.replace('The third day, there', 'There'), 'bkp:N2')).toEqual([])
  })

  it('passes the 3rd day and flags the 4th', () => {
    expect(check('JHN 2:1', 'On the 3rd day, there was a wedding in Cana of Galilee.', 'bkp:N2')).toEqual([])
    expect(check('JHN 2:1', 'On the 4th day, there was a wedding in Cana of Galilee.', 'bkp:N2')[0]).toMatchObject({
      reason: 'ordinal-missing',
      params: { value: '3', accepts: 'digits' },
    })
  })
})

describe('M3: a negation stays', () => {
  it('passes JHN 3:18, whose three negations the WEB keeps', () => {
    expect(JHN.get('JHN 3:18')?.negation?.units).toBe(3)
    expect(check('JHN 3:18', WEB_3_18, 'bkp:M3')).toEqual([])
  })

  it('flags JHN 3:18 when one of its three "not"s is dropped: the clauses are separate negations', () => {
    const [finding] = check('JHN 3:18', WEB_3_18.replace('is not judged', 'is judged'), 'bkp:M3')
    expect(finding).toMatchObject({ reason: 'negation-fewer', severity: 'info', params: { expected: '3', found: '2' } })
  })

  it('flags a verse that loses its only negation as a warning: the meaning flips', () => {
    const [finding] = check('JHN 21:11', WEB_21_11.replace('wasn’t torn', 'was torn'), 'bkp:M3')
    expect(finding).toMatchObject({
      reason: 'negation-missing',
      severity: 'warning',
      evidence: { kind: 'negation', refs: ['JHN 21:11'] },
    })
  })

  it('counts οὐ μή as one emphatic negation (JHN 4:14 "will never thirst")', () => {
    expect(JHN.get('JHN 4:14')?.negation?.units).toBe(1)
    const web =
      'but whoever drinks of the water that I will give him will never thirst again; but the water that I will give him will become in him a well of water springing up to eternal life.”'
    expect(check('JHN 4:14', web, 'bkp:M3')).toEqual([])
  })

  it('counts a negative and the compound negative in its clause once (JHN 5:30 οὐ … οὐδέν), the next clause apart', () => {
    expect(JHN.get('JHN 5:30')?.negation?.units).toBe(2)
  })

  it('leaves out what a translation says without a negator: a question opened by μή, litotes, εἰ μή "except"', () => {
    expect(JHN.get('JHN 4:12')?.negation).toBeNull()
    expect(JHN.get('JHN 2:12')?.negation).toBeNull()
    // οὐκ ἔρχεται εἰ μὴ ἵνα κλέψῃ: the οὐκ stays a negation, εἰ μή does not.
    expect(JHN.get('JHN 10:10')?.negation?.units).toBe(1)
  })

  it('does not count a "not" inside a footnote', () => {
    const noted = `${WEB_21_11.replace('wasn’t torn', 'was torn')}\\f + \\ft Some read: was not torn.\\f*`
    expect(check('JHN 21:11', noted, 'bkp:M3')[0]?.reason).toBe('negation-missing')
  })
})

describe('S3: a sentence that runs on into the next verse', () => {
  const web = 'Therefore when the Lord knew that the Pharisees had heard that Jesus was making and baptizing more disciples than John'

  it('passes JHN 4:1, which the WEB leaves open, and flags it closed with a full stop', () => {
    expect(check('JHN 4:1', web, 'bkp:S3')).toEqual([])
    const closed = `${web}.`
    expect(check('JHN 4:1', closed, 'bkp:S3')[0]).toMatchObject({
      reason: 'sentence-ends-early',
      spans: [{ start: closed.length - 1, end: closed.length }],
      evidence: { kind: 'move', refs: ['JHN 4:1'] },
    })
  })

  it('says nothing where the source sentence ends (JHN 4:3)', () => {
    expect(check('JHN 4:3', 'he left Judea and departed into Galilee.', 'bkp:S3')).toEqual([])
  })
})

describe('S6 and S7: the project policy for verses some manuscripts leave out', () => {
  // MAT 17:21 is not in the pack (SBLGNT omits it): its cell gets the variant facts alone.
  const MAT = compileFileExpectations(cellsFor(['MAT 17:21']), MAT_VOICES, MAT_STRUCTURE)
  const WEB_17_21 = 'But this kind doesn’t go out except by prayer and fasting.”'
  const s6 = (text: string, policy: LanguageProfile['textualVariants']) =>
    evaluateCell(text, MAT.get('MAT 17:21'), { ...ENGLISH, textualVariants: policy }).map((f) => [f.code, f.reason])

  it('omit: the cell stays empty, or holds only a note', () => {
    expect(s6(WEB_17_21, 'omit')).toEqual([['bkp:S6', 'variant-not-omitted']])
    expect(s6('', 'omit')).toEqual([])
    expect(s6('\\f + \\ft Some manuscripts add: But this kind does not go out except by prayer and fasting.\\f*', 'omit')).toEqual([])
  })

  it('bracket: the text is wrapped in [ ]', () => {
    expect(s6(WEB_17_21, 'bracket')).toEqual([['bkp:S6', 'variant-not-bracketed']])
    expect(s6('[But this kind doesn’t go out except by prayer and fasting.]”', 'bracket')).toEqual([])
  })

  it('footnote: the cell has a \\f note', () => {
    expect(s6(WEB_17_21, 'footnote')).toEqual([['bkp:S6', 'variant-no-footnote']])
    expect(s6(`${WEB_17_21}\\f + \\ft Some manuscripts do not have this verse.\\f*`, 'footnote')).toEqual([])
  })

  it('runs no other check on a verse the pack lacks: the quotation mark is not "marks without speech"', () => {
    const quoting = { ...ENGLISH, quoteMarks: { levels: [{ open: '“', close: '”' }], continuation: 'none' as const } }
    expect(evaluateCell(WEB_17_21, MAT.get('MAT 17:21'), quoting).map((f) => f.code)).toEqual(['bkp:S6'])
  })

  it('brackets a disputed passage once: open at JHN 7:53, close at JHN 8:11, nothing in between', () => {
    const s7 = (ref: string, text: string, policy: LanguageProfile['textualVariants'] = 'bracket') =>
      check(ref, text, 'bkp:S7', { ...ENGLISH, textualVariants: policy }).map((f) => f.reason)
    expect(s7('JHN 7:53', '[Everyone went to his own house,')).toEqual([])
    expect(s7('JHN 7:53', 'Everyone went to his own house,')).toEqual(['variant-not-bracketed'])
    expect(s7('JHN 8:1', 'but Jesus went to the Mount of Olives.')).toEqual([])
    expect(s7('JHN 8:11', 'She said, “No one, Lord.” Jesus said, “Neither do I condemn you. Go your way. From now on, sin no more.”]')).toEqual([])
    expect(s7('JHN 8:11', 'She said, “No one, Lord.” Jesus said, “Neither do I condemn you. Go your way. From now on, sin no more.”')).toEqual([
      'variant-not-bracketed',
    ])
    // The footnote goes where the passage begins.
    expect(s7('JHN 7:53', 'Everyone went to his own house,', 'footnote')).toEqual(['variant-no-footnote'])
    expect(s7('JHN 8:11', 'She said, “No one, Lord.”', 'footnote')).toEqual([])
  })
})

describe('dormancy: each check waits for its Language-profile slot', () => {
  const broken = WEB_21_11.replace('one hundred fifty-three ', '').replace('wasn’t torn', 'was torn')

  it('reports nothing for numbers, negation, run-on sentences or variants until their slot is filled', () => {
    expect(evaluateCell(broken, JHN.get('JHN 21:11'), {})).toEqual([])
    expect(evaluateCell('Everyone went to his own house,', JHN.get('JHN 7:53'), {})).toEqual([])
    expect(evaluateCell('than John.', JHN.get('JHN 4:1'), {})).toEqual([])
  })

  it('switches each check on with its own slot only', () => {
    const codes = (profile: LanguageProfile) => evaluateCell(broken, JHN.get('JHN 21:11'), profile).map((f) => f.code)
    expect(codes({ numberWords: 'cldr' })).toEqual(['bkp:N1'])
    expect(codes({ negators: ['not'] })).toEqual(['bkp:M3'])
    expect(isBibleCheckDormant('bkp:S3', { negators: ['not'] })).toBe(true)
    expect(isBibleCheckDormant('bkp:S6', { textualVariants: 'omit' })).toBe(false)
    expect(isBibleCheckDormant('bkp:S8', {})).toBe(false)
  })
})

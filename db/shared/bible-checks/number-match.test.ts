// AQU-1697: how N1 and N2 read a number in a translation.
//
// WHY: a translation may write 153 in its own digits, group thousands its own
// way, or spell the number out word by word. Each reading a published Bible
// uses must count as keeping the number, or N1 flags correct verses.

import { describe, expect, it } from 'vitest'
import { digitNumbers, writesNumber } from './number-match'

describe('digitNumbers', () => {
  it('reads 153 in any decimal digit system', () => {
    for (const written of ['153', '१५३', '١٥٣', '۱۵۳', '๑๕๓', '၁၅၃', '১৫৩', '１５３']) {
      expect(digitNumbers(`about ${written} fish`).has(153)).toBe(true)
    }
  })

  it('reads thousands however they are grouped', () => {
    expect(digitNumbers('144,000 sealed').has(144000)).toBe(true)
    expect(digitNumbers('1,44,000 sealed').has(144000)).toBe(true)
    expect(digitNumbers('144\u202F000 sealed').has(144000)).toBe(true)
    expect(digitNumbers('144.000 sealed').has(144000)).toBe(true)
  })

  it('keeps each number of a list apart', () => {
    expect([...digitNumbers('chapters 3, 4 and 5')].sort()).toEqual([3, 4, 5])
  })
})

describe('writesNumber', () => {
  const english = { '3': 'three', '50': 'fifty', '100': 'hundred' }

  it('accepts the words for each Greek part: ἑκατὸν πεντήκοντα τριῶν is "one hundred fifty-three"', () => {
    expect(writesNumber('full of one hundred fifty-three great fish', 153, [100, 50, 3], english).found).toBe(true)
  })

  it('needs every part: "fifty-three" is not 153', () => {
    expect(writesNumber('full of fifty-three great fish', 153, [100, 50, 3], english)).toEqual({ found: false, hasWords: true })
  })

  it('reads a number word as a whole word only: "seventy" is not "seven"', () => {
    expect(writesNumber('the seventy returned', 7, [7], { '7': 'seven' }).found).toBe(false)
  })

  it('says when the profile has no word for the number', () => {
    expect(writesNumber('many fish', 153, [100, 50, 3], { '12': 'twelve' })).toEqual({ found: false, hasWords: false })
  })
})

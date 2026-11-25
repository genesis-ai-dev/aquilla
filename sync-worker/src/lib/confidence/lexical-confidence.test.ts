import { describe, it, expect } from 'vitest'
import { confidenceTerms, lexicalConfidence, lexicalSimilarity } from './lexical-confidence'

describe('confidenceTerms (character n-grams, AQU-2727)', () => {
  it('ignores case and punctuation', () => {
    expect(confidenceTerms('Abraham, Isaac; Jacob.')).toEqual(confidenceTerms('abraham isaac jacob'))
  })

  it('is empty for empty / punctuation-only input', () => {
    expect(confidenceTerms('').size).toBe(0)
    expect(confidenceTerms('  ;; .. ').size).toBe(0)
  })
})

describe('lexicalConfidence (one-hop, term coverage)', () => {
  it('is 0 when the query has no terms', () => {
    expect(lexicalConfidence('', ['anything'])).toBe(0)
    expect(lexicalConfidence(';;;', ['anything'])).toBe(0)
  })

  it('is 0 when there are no validated neighbors', () => {
    expect(lexicalConfidence('the son of David', [])).toBe(0)
  })

  it('is 1 when a neighbor covers every query term', () => {
    expect(lexicalConfidence('the son of David', ['the son of David the king'])).toBe(1)
  })

  it('is the fraction of query terms a neighbor covers', () => {
    // " ab", "abc", "bc ", "c x", " xy", "xyz", "yz " — the neighbor has 3 of 7.
    expect(lexicalConfidence('abc xyz', ['abc'])).toBeCloseTo(3 / 7)
  })

  it('takes the best (max) coverage across neighbors — one hop', () => {
    const query = 'alpha beta gamma delta'
    const conf = lexicalConfidence(query, ['alpha', 'alpha beta gamma', 'zeta'])
    expect(conf).toBeCloseTo(lexicalConfidence(query, ['alpha beta gamma']))
    expect(conf).toBeGreaterThan(lexicalConfidence(query, ['alpha']))
    expect(conf).toBeLessThan(1)
  })

  it('is case- and punctuation-insensitive', () => {
    expect(lexicalConfidence('Abraham, Isaac', ['abraham isaac jacob'])).toBe(1)
  })

  it('dedupes repeated query terms (coverage is over distinct terms)', () => {
    // " ab","abc","bc ","c a" — each counted once, however often it repeats.
    expect(lexicalConfidence('abc abc abc', ['abc'])).toBeCloseTo(3 / 4)
  })

  it('scores unspaced scripts by shared text, not whole verses (AQU-2727)', () => {
    // One "word" per verse under the old tokenizer, so this was 0.
    expect(lexicalConfidence('銅器皿', ['金器皿和銀器皿'])).toBeGreaterThan(0)
    expect(lexicalConfidence('พระเจ้าทรงสร้าง', ['ในเริ่มแรกนั้นพระเจ้าทรงสร้างฟ้า'])).toBeGreaterThan(0.5)
  })

  it('scores a Devanagari genealogy cell against its validated neighbors', () => {
    // Mirrors the screenshot: an unvalidated genealogy cell shares most of its
    // recurring names with validated genealogy cells → high confidence.
    const query = 'अरामले अम्मीनादाब अम्मीनादाबले नहशोन नहशोनले सल्मोन'
    const validatedNeighbors = [
      'यहूदाले तामारेपाईन पेरेस अनी जेरह व्यनात पेरेसले हेस्रोन',
      'अरामले अम्मीनादाब अम्मीनादाबले नहशोन नहशोनले सल्मोन व्यनात',
    ]
    expect(lexicalConfidence(query, validatedNeighbors)).toBe(1)
  })
})

describe('lexicalSimilarity (AQU-1232)', () => {
  it('is 1 for identical term sets and 0 for disjoint ones', () => {
    expect(lexicalSimilarity('In the beginning', 'in, the BEGINNING!')).toBe(1)
    expect(lexicalSimilarity('In the beginning', 'peace unto you')).toBe(0)
  })

  it('is symmetric', () => {
    const a = 'God created the heavens'
    const b = 'God created the earth also'
    expect(lexicalSimilarity(a, b)).toBeCloseTo(lexicalSimilarity(b, a))
  })

  it('ranks a near-duplicate above a superset that merely contains the query', () => {
    const query = 'God created the heavens'
    const near = 'God created the earth'
    // Contains every query term, plus a long tail — a coverage score would call
    // this a perfect 1.0 and hand the agent the wrong precedent.
    const superset = 'God created the heavens and every living creature upon the waters below'
    expect(lexicalConfidence(query, [superset])).toBe(1) // the trap, for contrast
    expect(lexicalSimilarity(query, near)).toBeGreaterThan(lexicalSimilarity(query, superset))
  })

  it('computes Jaccard over distinct terms', () => {
    // A = {" ab","abc","bc "}, B = A + {"c x"," xy","xyz","yz "} → 3 / 7.
    expect(lexicalSimilarity('abc', 'abc xyz')).toBeCloseTo(3 / 7)
    // Repeats do not skew it: {" ab","abc","bc ","c a"} vs {" ab","abc","bc "} → 3 / 4.
    expect(lexicalSimilarity('abc abc abc', 'abc')).toBeCloseTo(3 / 4)
  })

  it('is 0 when either side has no terms', () => {
    expect(lexicalSimilarity('', 'anything')).toBe(0)
    expect(lexicalSimilarity('!!! ???', 'anything')).toBe(0)
  })
})

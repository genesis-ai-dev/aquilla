import { describe, it, expect } from 'vitest'
import { tokenizeForConfidence, lexicalConfidence, lexicalSimilarity } from './lexical-confidence'

describe('tokenizeForConfidence', () => {
  it('lowercases and splits on punctuation/whitespace', () => {
    expect(tokenizeForConfidence('Abraham, Isaac; Jacob.')).toEqual([
      'abraham',
      'isaac',
      'jacob',
    ])
  })

  it('returns [] for empty / punctuation-only input', () => {
    expect(tokenizeForConfidence('')).toEqual([])
    expect(tokenizeForConfidence('  ;; .. ')).toEqual([])
  })

  it('tokenizes non-Latin (Devanagari) script', () => {
    // Two Devanagari words separated by a space and a danda.
    expect(tokenizeForConfidence('अब्राहामले इसहाक॥')).toEqual([
      'अब्राहामले',
      'इसहाक',
    ])
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
    // query has 4 distinct terms; neighbor covers 2 of them.
    expect(lexicalConfidence('alpha beta gamma delta', ['alpha beta'])).toBeCloseTo(0.5)
  })

  it('takes the best (max) coverage across neighbors — one hop', () => {
    const conf = lexicalConfidence('alpha beta gamma delta', [
      'alpha', // 0.25
      'alpha beta gamma', // 0.75
      'zeta', // 0
    ])
    expect(conf).toBeCloseTo(0.75)
  })

  it('is case- and punctuation-insensitive', () => {
    expect(lexicalConfidence('Abraham, Isaac', ['abraham isaac jacob'])).toBe(1)
  })

  it('dedupes repeated query terms (coverage is over distinct terms)', () => {
    // 2 distinct terms; neighbor has one of them → 0.5, not skewed by the repeat.
    expect(lexicalConfidence('name name other', ['name'])).toBeCloseTo(0.5)
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
    expect(lexicalSimilarity('In the beginning', 'peace be with you')).toBe(0)
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
    // A = {a,b,c}, B = {b,c,d} → |∩| = 2, |∪| = 4.
    expect(lexicalSimilarity('a b c', 'b c d')).toBeCloseTo(0.5)
    // Repeats do not skew it: A = {name}, B = {name, other} → 1/2.
    expect(lexicalSimilarity('name name name', 'name other')).toBeCloseTo(0.5)
  })

  it('is 0 when either side has no terms', () => {
    expect(lexicalSimilarity('', 'anything')).toBe(0)
    expect(lexicalSimilarity('!!! ???', 'anything')).toBe(0)
  })
})

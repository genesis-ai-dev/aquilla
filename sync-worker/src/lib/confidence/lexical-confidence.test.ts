import { describe, it, expect } from 'vitest'
import { tokenizeForConfidence, lexicalConfidence } from './lexical-confidence'

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

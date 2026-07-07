// Payable/weighted word computation (Matecat-parity run).
//
// Default rates are FROZEN from Matecat's documented model
// (https://guides.matecat.com/how-matecat-calculates-payable-words):
//   New 100% · Repetitions 30% · Internal 75–99% 60% · TM fuzzy 75–99% 60% ·
//   TM 100% 30% · In-Context Exact (101%) 0% · MT 77%.
// Rates are configurable per project (Matecat "custom billing models").
import type { Bucket } from "./buckets"

export type PayableBand =
  | Bucket // "new" | "repetition" | "internal_75_99"
  | "tm_100"
  | "tm_75_99"
  | "ice"
  | "mt"

export type RateTable = Record<PayableBand, number>

export const DEFAULT_RATES: RateTable = {
  new: 1.0,
  repetition: 0.3,
  internal_75_99: 0.6,
  tm_75_99: 0.6,
  tm_100: 0.3,
  ice: 0,
  mt: 0.77,
}

export interface BandBreakdown {
  band: PayableBand
  words: number
  rate: number
  payable: number
}

export interface PayableResult {
  totalWords: number
  payableWords: number
  /** "Saving on word count" percentage, as on Matecat's analysis page. */
  discountPct: number
  bands: BandBreakdown[]
}

/** Compute weighted/payable words from per-band raw word counts. */
export function computePayable(
  wordsPerBand: Partial<Record<PayableBand, number>>,
  rates: RateTable = DEFAULT_RATES,
): PayableResult {
  const bands: BandBreakdown[] = (Object.keys(rates) as PayableBand[])
    .filter((band) => (wordsPerBand[band] ?? 0) > 0)
    .map((band) => {
      const words = wordsPerBand[band] ?? 0
      const rate = rates[band]
      return { band, words, rate, payable: Math.round(words * rate * 100) / 100 }
    })
  const totalWords = bands.reduce((a, b) => a + b.words, 0)
  const payableWords = Math.round(bands.reduce((a, b) => a + b.payable, 0) * 100) / 100
  return {
    totalWords,
    payableWords,
    discountPct: totalWords === 0 ? 0 : Math.round((1 - payableWords / totalWords) * 1000) / 10,
    bands,
  }
}

// Match-band bucketing for volume analysis (Matecat-parity run).
//
// Buckets follow Matecat's documented payable-words model
// (https://guides.matecat.com/how-matecat-calculates-payable-words):
//   - NEW: first occurrence, no internal match ≥75%
//   - REPETITIONS: exact duplicate (normalized) of an EARLIER segment
//   - INTERNAL_75_99: 75–99% similar to an earlier segment in the same batch
//     ("document-internal fuzzy")
// TM bands (TM_100 / TM_75_99 / ICE) and MT are assigned by the caller when a
// TM lookup layer is wired in; this module owns the document-internal part.
import { countWords } from "./wordcount"

export type Bucket = "new" | "repetition" | "internal_75_99"

export interface BucketedSegment {
  index: number
  source: string
  words: number
  bucket: Bucket
  /** For internal fuzzies: similarity (0–1) to the best earlier match. */
  similarity?: number
}

export const normalizeSource = (s: string): string =>
  s.toLowerCase().replace(/\s+/g, " ").trim()

/** Token-shingle Dice similarity — deterministic, language-agnostic. */
export function sourceSimilarity(a: string, b: string): number {
  const tokens = (s: string): string[] => normalizeSource(s).split(" ").filter(Boolean)
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.length === 0 || tb.length === 0) return 0
  const bag = (ts: string[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const t of ts) m.set(t, (m.get(t) ?? 0) + 1)
    return m
  }
  const ma = bag(ta)
  const mb = bag(tb)
  let overlap = 0
  for (const [t, n] of ma) overlap += Math.min(n, mb.get(t) ?? 0)
  return (2 * overlap) / (ta.length + tb.length)
}

/**
 * Assign each segment to a document-internal bucket. Repetitions compare by
 * normalized equality against ALL earlier segments; internal fuzzies use the
 * best similarity ≥0.75 (and <1.0) against a bounded window of earlier
 * segments (window keeps the pass O(n·w) — Matecat computes this server-side
 * during analysis; 500 covers typical file sizes without quadratic blowup).
 */
export function bucketSegments(sources: string[], fuzzyWindow = 500): BucketedSegment[] {
  const seen = new Set<string>()
  const window: string[] = []
  const out: BucketedSegment[] = []
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]
    const norm = normalizeSource(source)
    const words = countWords(source)
    if (seen.has(norm)) {
      out.push({ index: i, source, words, bucket: "repetition" })
    } else {
      let best = 0
      for (const prev of window) {
        const sim = sourceSimilarity(source, prev)
        if (sim > best) best = sim
      }
      if (best >= 0.75 && best < 1) {
        out.push({ index: i, source, words, bucket: "internal_75_99", similarity: best })
      } else {
        out.push({ index: i, source, words, bucket: "new" })
      }
      seen.add(norm)
      window.push(source)
      if (window.length > fuzzyWindow) window.shift()
    }
  }
  return out
}

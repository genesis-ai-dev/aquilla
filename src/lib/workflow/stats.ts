// Segment-status progress stats (Matecat-parity run) — the raw/equivalent
// per-state counters Matecat exposes on jobs (stats.raw × new/draft/
// translated/approved). Aquilla's status ladder maps: empty≈new,
// unvalidated≈translated(draft), validated≈approved.
import { countWords } from "@/lib/analysis/wordcount"

export interface StatSegment {
  source: string
  translated: string
  status: "empty" | "unvalidated" | "validated"
}

export interface StatusCounts {
  empty: number
  unvalidated: number
  validated: number
  total: number
}

export interface ProgressStats {
  segments: StatusCounts
  /** Raw source word counts per status (Matecat stats.raw analog). */
  words: StatusCounts
  completionPct: number
}

export function segmentStatusCounts(segments: { status: StatSegment["status"] }[]): StatusCounts {
  const counts: StatusCounts = { empty: 0, unvalidated: 0, validated: 0, total: segments.length }
  for (const s of segments) counts[s.status]++
  return counts
}

export function progressStats(segments: StatSegment[]): ProgressStats {
  const seg = segmentStatusCounts(segments)
  const words: StatusCounts = { empty: 0, unvalidated: 0, validated: 0, total: 0 }
  for (const s of segments) {
    const w = countWords(s.source)
    words[s.status] += w
    words.total += w
  }
  const done = words.unvalidated + words.validated
  return {
    segments: seg,
    words,
    completionPct: words.total === 0 ? 0 : Math.round((done / words.total) * 1000) / 10,
  }
}

/** Audacity-style label-track importer.
 *
 * Forced aligners and Audacity export a "label track" as tab-separated lines:
 *   `<startSeconds>\t<endSeconds>\t<label>`
 * one per line (Windows CRLF is common). For scripture audio the label is a
 * verse id plus an optional sub-verse phrase letter, e.g. `1a`, `12d`, `9`,
 * `32-34q` (the verse id itself may be a range like `32-34`).
 *
 * This parser is dialect-agnostic about the label beyond that shape: it keeps
 * the raw `label`, and splits it into `verseId` (digits, optionally a
 * `N-M` range) + `phrase` (trailing lowercase letters, possibly empty).
 * `start`/`end` are fractional seconds. Malformed lines are skipped.
 */

export interface LabelSegment {
  start: number
  end: number
  label: string
  verseId: string
  phrase: string
}

const LABEL_RE = /^(\d+(?:-\d+)?)([a-z]*)$/

export function parseLabelTrack(content: string): LabelSegment[] {
  const segments: LabelSegment[] = []
  for (const raw of content.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (line === "") continue
    const cols = line.split("\t")
    if (cols.length < 3) continue
    const start = Number(cols[0])
    const end = Number(cols[1])
    const label = cols[2].trim()
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    const m = label.match(LABEL_RE)
    segments.push({
      start,
      end,
      label,
      verseId: m ? m[1] : label,
      phrase: m ? m[2] : "",
    })
  }
  return segments
}

export interface VerseWindow {
  verseId: string
  startMs: number
  endMs: number
}

/** Collapse a verse's phrase segments into a single millisecond window: the
 * earliest start and latest end across all segments sharing a `verseId`.
 * Verses keep first-appearance order. Segment order within a verse and any
 * small gaps between phrases are intentionally discarded — the window is what
 * attaches to a verse cell as its playable clip. */
export function groupSegmentsByVerse(segments: LabelSegment[]): VerseWindow[] {
  const order: string[] = []
  const bounds = new Map<string, { start: number; end: number }>()
  for (const s of segments) {
    const cur = bounds.get(s.verseId)
    if (!cur) {
      order.push(s.verseId)
      bounds.set(s.verseId, { start: s.start, end: s.end })
    } else {
      if (s.start < cur.start) cur.start = s.start
      if (s.end > cur.end) cur.end = s.end
    }
  }
  return order.map((verseId) => {
    const b = bounds.get(verseId)!
    return { verseId, startMs: Math.round(b.start * 1000), endMs: Math.round(b.end * 1000) }
  })
}

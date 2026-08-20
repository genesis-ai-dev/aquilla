import type { CellData } from "@/hooks/useCells"

export interface TimestampRange {
  start: number // seconds
  end: number   // seconds
}

// Match HH:MM:SS.mmm (VTT) or HH:MM:SS,mmm (SRT). Tolerant of extra whitespace.
const TIMESTAMP_RANGE_RE =
  /^\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*$/

export function parseTimestampRange(context: string): TimestampRange | null {
  const match = context.match(TIMESTAMP_RANGE_RE)
  if (!match) return null
  const [, h1, m1, s1, ms1, h2, m2, s2, ms2] = match
  return {
    start: Number(h1) * 3600 + Number(m1) * 60 + Number(s1) + Number(ms1) / 1000,
    end: Number(h2) * 3600 + Number(m2) * 60 + Number(s2) + Number(ms2) / 1000,
  }
}

/**
 * `HH:MM:SS.mmm`, rounded to the millisecond.
 *
 * ROUNDED ONCE, TO A WHOLE NUMBER OF MILLISECONDS, and every field derived from
 * that. Rounding the fractional part on its own let it reach 1000 with nothing
 * to carry into: `formatVttTime(1.9995)` returned `"00:00:01.1000"` — a
 * four-digit millisecond field that the app's own VTT parser rejects, in a file
 * we had just written. Cue times parsed from a VTT are exact multiples of a
 * millisecond and never hit it; a cue somebody dragged on the timeline, or one
 * scaled by a timebase correction, is an arbitrary float and does.
 */
export function formatVttTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000))
  const pad = (n: number, width = 2) => n.toString().padStart(width, "0")
  return (
    `${pad(Math.floor(totalMs / 3_600_000))}:` +
    `${pad(Math.floor((totalMs % 3_600_000) / 60_000))}:` +
    `${pad(Math.floor((totalMs % 60_000) / 1000))}.` +
    `${pad(totalMs % 1000, 3)}`
  )
}

export function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()
}

export function generateVttFromCells(cells: CellData[]): string {
  const cues: string[] = []
  for (const cell of cells) {
    const range = parseTimestampRange(cell.context)
    if (!range) continue
    const text = (cell.translated || cell.original || "").trim()
    if (!text) continue
    const cleanText = stripHtml(text)
    cues.push(
      `${formatVttTime(range.start)} --> ${formatVttTime(range.end)}\n${cleanText}`
    )
  }
  return `WEBVTT\n\n${cues.join("\n\n")}${cues.length > 0 ? "\n" : ""}`.replace(
    /\n{3,}/g,
    "\n\n"
  )
}

export interface CueForOverlay {
  start: number
  end: number
  text: string
}

// Extract a plain list of cues from cells, suitable for driving a custom
// subtitle overlay (bypassing iframe-based players that ignore <track> children).
// Cells without a timestamp context are skipped; translated text preferred over
// original; HTML stripped.
export function extractCuesFromCells(cells: CellData[]): CueForOverlay[] {
  const cues: CueForOverlay[] = []
  for (const cell of cells) {
    const range = parseTimestampRange(cell.context)
    if (!range) continue
    const raw = (cell.translated || cell.original || "").trim()
    if (!raw) continue
    cues.push({
      start: range.start,
      end: range.end,
      text: stripHtml(raw),
    })
  }
  return cues
}

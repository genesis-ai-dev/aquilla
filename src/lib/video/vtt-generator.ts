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

function formatVttTime(seconds: number): string {
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0")
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0")
  const s = Math.floor(seconds % 60).toString().padStart(2, "0")
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000).toString().padStart(3, "0")
  return `${h}:${m}:${s}.${ms}`
}

function stripHtml(text: string): string {
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

// Build a Blob URL for a VTT string. Caller owns the URL and must revoke it.
export function createVttBlobUrl(vtt: string): string {
  const blob = new Blob([vtt], { type: "text/vtt" })
  return URL.createObjectURL(blob)
}

function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0")
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0")
  const s = Math.floor(seconds % 60).toString().padStart(2, "0")
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000).toString().padStart(3, "0")
  return `${h}:${m}:${s},${ms}`
}

export function generateSrtFromCells(cells: CellData[]): string {
  const cues: string[] = []
  let index = 1
  for (const cell of cells) {
    const range = parseTimestampRange(cell.context)
    if (!range) continue
    const text = (cell.translated || cell.original || "").trim()
    if (!text) continue
    const cleanText = stripHtml(text)
    cues.push(
      `${index}\n${formatSrtTime(range.start)} --> ${formatSrtTime(range.end)}\n${cleanText}`
    )
    index++
  }
  return cues.length > 0 ? cues.join("\n\n") + "\n" : ""
}

export function createSrtBlobUrl(srt: string): string {
  const blob = new Blob([srt], { type: "text/srt" })
  return URL.createObjectURL(blob)
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

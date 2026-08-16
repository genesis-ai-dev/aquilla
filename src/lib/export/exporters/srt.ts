// SRT (SubRip) exporter. Produces a subtitle file from timed cells: sequential
// cue numbers, `HH:MM:SS,mmm --> HH:MM:SS,mmm` timecode lines, translated text
// (falling back to source for untranslated cells — Matecat-style draft export).
// Inline subtitle markup (<i>, <b>, <font>) in the text is passed through
// verbatim: SRT payload tags are content, not formatting to strip.
import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"

const pad = (n: number, w = 2): string => String(n).padStart(w, "0")

/** Format seconds as an SRT timestamp (HH:MM:SS,mmm). */
export function formatSrtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(
    Math.floor(ms / 1000) % 60,
  )},${pad(ms % 1000, 3)}`
}

/** SRT export. Each timed cell becomes a numbered cue; cells without
 *  timecodes are skipped (same contract as exportVtt). */
export function exportSrt(cells: CellData[]): Blob {
  const cues: string[] = []
  for (const cell of cells) {
    if (cell.startTime == null || cell.endTime == null) continue
    const text = (cell.translated || effectiveSourceText(cell) || "").trim()
    if (!text) continue
    cues.push(`${cues.length + 1}\n${formatSrtTime(cell.startTime)} --> ${formatSrtTime(cell.endTime)}\n${text}`)
  }
  const body = cues.length ? `${cues.join("\n\n")}\n` : ""
  return new Blob([body], { type: "application/x-subrip;charset=utf-8" })
}

// Structure-preserving WEBVTT exporter for CAT round-trip use.
//
// Differs from exportVtt (which serves the TTS/cast workflow) in two ways:
//   1. Inline VTT payload tags (<b>, <i>, <c>, <lang>…) in the text are passed
//      through verbatim instead of being stripped — they are cue content.
//   2. The voice tag is reconstructed from the cell's imported `speaker`
//      rather than from project TTS cast settings, so a file imported with
//      <v Name> cues exports with the same voices without any project setup.
// exportVtt is untouched (C7: existing behavior stays byte-identical).
import type { CellData } from "@/hooks/useCells"
import { escapeVoiceName } from "@/lib/export/vtt-voice"

const pad = (n: number, w = 2): string => String(n).padStart(w, "0")

/** Format seconds as a VTT timestamp (HH:MM:SS.mmm). */
export function formatVttTimeFull(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(
    Math.floor(ms / 1000) % 60,
  )}.${pad(ms % 1000, 3)}`
}

interface SpeakerCell extends CellData {
  speaker?: string
}

/** WEBVTT export preserving cue text verbatim and re-emitting `<v Speaker>`
 *  tags from the imported speaker label. Untimed cells are skipped. */
export function exportVttStructured(cells: CellData[]): Blob {
  const cues: string[] = []
  for (const cell of cells as SpeakerCell[]) {
    if (cell.startTime == null || cell.endTime == null) continue
    const text = (cell.translated || cell.original || "").trim()
    if (!text) continue
    const payload = cell.speaker ? `<v ${escapeVoiceName(cell.speaker)}>${text}</v>` : text
    cues.push(`${formatVttTimeFull(cell.startTime)} --> ${formatVttTimeFull(cell.endTime)}\n${payload}`)
  }
  const body = cues.length ? `WEBVTT\n\n${cues.join("\n\n")}\n` : "WEBVTT\n"
  return new Blob([body], { type: "text/vtt;charset=utf-8" })
}

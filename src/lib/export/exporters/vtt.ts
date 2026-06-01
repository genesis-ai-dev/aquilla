// WEBVTT exporter. Produces a subtitle file from timed cells; cells explicitly
// assigned to a Cast member get a `<v Name>` voice tag (default-only/unassigned
// cells stay plain — matching codex-editor's "no tag unless labeled").
// Cells without startTime/endTime are skipped.

import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import { assignedCastVoiceId, findVoice } from "@/lib/audio/voices"
import { escapeVoiceName } from "@/lib/export/vtt-voice"

function fmt(sec: number): string {
  const h = String(Math.floor(sec / 3600)).padStart(2, "0")
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0")
  const s = String(Math.floor(sec % 60)).padStart(2, "0")
  const ms = String(Math.round((sec - Math.floor(sec)) * 1000)).padStart(3, "0")
  return `${h}:${m}:${s}.${ms}`
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()
}

/** WEBVTT export. Each timed cell becomes a cue; cells explicitly assigned to a
 *  Cast member get a `<v Name>` voice tag (default-only/unassigned cells stay
 *  plain — matching codex-editor). Cells without timecodes are skipped. */
export function exportVtt(cells: CellData[], settings: ProjectTtsSettings | undefined): Blob {
  const cues: string[] = []
  for (const cell of cells) {
    if (cell.startTime == null || cell.endTime == null) continue
    const raw = (cell.translated || cell.original || "").trim()
    if (!raw) continue
    const text = stripHtml(raw)
    const voiceId = assignedCastVoiceId(settings, cell.id)
    const voice = voiceId ? findVoice(settings, voiceId) : undefined
    const payload = voice ? `<v ${escapeVoiceName(voice.name)}>${text}</v>` : text
    cues.push(`${fmt(cell.startTime)} --> ${fmt(cell.endTime)}\n${payload}`)
  }
  const body = cues.length ? `WEBVTT\n\n${cues.join("\n\n")}\n` : "WEBVTT\n"
  return new Blob([body], { type: "text/vtt;charset=utf-8" })
}

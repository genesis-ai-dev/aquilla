// WEBVTT exporter. Produces a subtitle file from timed cells; cells explicitly
// assigned to a Cast member get a `<v Name>` voice tag (default-only/unassigned
// cells stay plain — matching codex-editor's "no tag unless labeled").
// Cells without startTime/endTime are skipped.

import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import { assignedCastVoiceId, findVoice } from "@/lib/audio/voices"
import { escapeVoiceName } from "@/lib/export/vtt-voice"
import { formatVttTime, stripHtml } from "@/lib/video/vtt-generator"

/** WEBVTT export. Each timed cell becomes a cue; cells explicitly assigned to a
 *  Cast member get a `<v Name>` voice tag (default-only/unassigned cells stay
 *  plain — matching codex-editor). Cells without timecodes are skipped. */
export function exportVtt(cells: CellData[], settings: ProjectTtsSettings | undefined): Blob {
  const cues: string[] = []
  for (const cell of cells) {
    if (cell.startTime == null || cell.endTime == null) continue
    const raw = (cell.translated || effectiveSourceText(cell) || "").trim()
    if (!raw) continue
    const text = stripHtml(raw)
    const voiceId = assignedCastVoiceId(settings, cell.id)
    const voice = voiceId ? findVoice(settings, voiceId) : undefined
    const payload = voice ? `<v ${escapeVoiceName(voice.name)}>${text}</v>` : text
    cues.push(`${formatVttTime(cell.startTime)} --> ${formatVttTime(cell.endTime)}\n${payload}`)
  }
  const body = cues.length ? `WEBVTT\n\n${cues.join("\n\n")}\n` : "WEBVTT\n"
  return new Blob([body], { type: "text/vtt;charset=utf-8" })
}

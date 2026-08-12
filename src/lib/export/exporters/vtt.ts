// WEBVTT exporter. Produces a subtitle file from timed cells; cells explicitly
// assigned to a Cast member get a `<v Name>` voice tag (default-only/unassigned
// cells stay plain — matching codex-editor's "no tag unless labeled").
// Cells without startTime/endTime are skipped.
//
// AQU-646: cues come out in TIME order, and a line someone added into a silence
// keeps its cue even with nothing written in it yet. See the notes on the sort
// and the blank-payload carve-out below.

import type { CellData } from "@/hooks/useCells"
import { effectiveSourceText } from "@/lib/cell-text"
import { isUserAddedLine } from "@/lib/timeline/user-lines"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import { assignedCastVoiceId, findVoice } from "@/lib/audio/voices"
import { escapeVoiceName } from "@/lib/export/vtt-voice"
import { formatVttTime, stripHtml } from "@/lib/video/vtt-generator"
import { sortedByTime } from "./subtitle-order"

/** WEBVTT export. Each timed cell becomes a cue; cells explicitly assigned to a
 *  Cast member get a `<v Name>` voice tag (default-only/unassigned cells stay
 *  plain — matching codex-editor). Cells without timecodes are skipped. */
export function exportVtt(cells: CellData[], settings: ProjectTtsSettings | undefined): Blob {
  const cues: string[] = []
  for (const cell of sortedByTime(cells)) {
    if (cell.startTime == null || cell.endTime == null) continue
    const raw = (cell.translated || effectiveSourceText(cell) || "").trim()
    // A line someone added into a silence keeps its cue even with nothing
    // written in it yet — it may carry a recording, and its TIMING is real
    // work that the file has to preserve either way (Sam, 2026-08-12: a blank
    // text line, never a placeholder, which would be fake text that could
    // reach a screen). An imported cue with no text is still skipped: that is
    // an untranslated line, not a deliberately silent one.
    if (!raw && !isUserAddedLine(cell)) continue
    const text = raw ? stripHtml(raw) : ""
    const voiceId = assignedCastVoiceId(settings, cell.id)
    const voice = voiceId ? findVoice(settings, voiceId) : undefined
    const payload = voice ? `<v ${escapeVoiceName(voice.name)}>${text}</v>` : text
    cues.push(`${formatVttTime(cell.startTime)} --> ${formatVttTime(cell.endTime)}\n${payload}`)
  }
  const body = cues.length ? `WEBVTT\n\n${cues.join("\n\n")}\n` : "WEBVTT\n"
  return new Blob([body], { type: "text/vtt;charset=utf-8" })
}

// Metadata spreadsheet exporter (AQU-441).
//
// Produces a CSV with one row per cell containing:
//   - cell_ref:      canonical ref (group field) or cell id when absent
//   - voice:         cast member name resolved from ttsSettings, or voiceId when
//                    a name can't be resolved, or "" when no cast assignment exists
//   - camera_state:  "on" | "mixed" | "off" | "" (absent/unknown)
//
// IMPORTANT: this is an EXPORT ONLY. The project (its event log and TTS
// settings) remains the single source of truth. Importing this CSV back has
// no defined path and is intentionally unsupported.
//
// The `csvField` quoting follows RFC 4180: fields containing commas, double-quotes,
// or line breaks are wrapped in double-quotes with internal double-quotes doubled.

import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

function csvField(value: string): string {
  if (value.includes('"') || value.includes(",") || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/**
 * Resolve a display name for a voice/cast member.
 * Looks up the voiceId in the project's voice library; falls back to the
 * raw voiceId string, then empty string when no assignment exists.
 */
function resolveVoiceName(
  voiceId: string | undefined,
  ttsSettings: ProjectTtsSettings | undefined,
): string {
  if (!voiceId) return ""
  const voice = ttsSettings?.voices?.find((v) => v.id === voiceId)
  return voice?.name ?? voiceId
}

/**
 * Export project cast and per-cell metadata as a CSV spreadsheet.
 *
 * Columns: cell_ref, voice (character/cast member), camera_state
 *
 * The cast assignment for a cell is resolved in priority order:
 *   1. Per-cell ttsSettings.voiceId  (set via cell-level assignment in the editor)
 *   2. Project-level castAssignments[cellId]  (bulk assignment from Voice Studio)
 *
 * @param cells       Target-side CellData array from the active file or full project.
 * @param ttsSettings Project TTS/voice-library settings used to resolve voice names.
 */
export function exportMetadataCsv(
  cells: CellData[],
  ttsSettings?: ProjectTtsSettings,
): Blob {
  const header = "cell_ref,voice,camera_state"

  const rows = cells.map((c) => {
    const ref = c.group || c.id

    // Resolve voice: cell-level setting takes precedence over project bulk assignment.
    const voiceId =
      c.ttsSettings?.voiceId ??
      (ttsSettings?.castAssignments?.[c.id] ?? undefined)
    const voice = resolveVoiceName(voiceId, ttsSettings)

    const cameraState = c.cameraState ?? ""

    return [csvField(ref), csvField(voice), csvField(cameraState)].join(",")
  })

  return new Blob([[header, ...rows].join("\r\n")], { type: "text/csv;charset=utf-8" })
}

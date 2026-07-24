// Thin wrapper around generateAndAttachCellVoice that builds the synth args
// from a CellData + project + session and drives the per-cell tts status badge
// (the same status CellTtsButton shows). Used by the Voice Studio's per-cell
// and "Generate all" flows so every cell synthesizes identically.

import { generateAndAttachCellVoice } from "./generate-voice"
import { resolveCastVoice } from "./voices"
import { setTtsStatus, ttsStatusKey, synthesizeForCell } from "./tts"
import { AiModelConsentDeniedError } from "./ai-consent"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

export interface GenerateCellVoiceArgs {
  project: ProjectRecord
  cell: CellData
  session: FrontierSession | null
  username: string
  /** Voice to use. Falls back to the cell's, then the project default. */
  voiceId?: string
  diffusionSteps?: number
}

/**
 * Generate + durably attach a voice for one cell. Returns true on success,
 * false when the cell has no target text or generation was declined/failed
 * (status is surfaced via the per-cell tts badge, not thrown).
 */
export async function generateCellVoice(args: GenerateCellVoiceArgs): Promise<boolean> {
  const { project, cell, session, username, voiceId, diffusionSteps } = args
  const text = cell.translated?.trim()
  if (!text) return false
  if (!session?.jwt) return false

  const statusKey = ttsStatusKey(cell.id)
  const onProgress: Parameters<typeof synthesizeForCell>[1]["onProgress"] = (p) => {
    setTtsStatus(statusKey, { kind: "loading", loaded: p.loaded, total: p.total, file: p.file })
    if (p.status === "ready" || (p.total > 0 && p.loaded >= p.total)) {
      setTtsStatus(statusKey, { kind: "synthesizing" })
    }
  }
  setTtsStatus(statusKey, { kind: "loading", loaded: 0, total: 0, file: "" })
  try {
    await generateAndAttachCellVoice({
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      text,
      projectTtsSettings: project.ttsSettings,
      // AQU-646: an explicit caller override wins; otherwise honor persisted
      // cast assignments (diarization's Speaker N → cell mapping) before the
      // cell's own voice, so batch + Voice Studio speak in the assigned voice.
      cellVoiceId: voiceId ?? resolveCastVoice(project.ttsSettings, cell.id, cell.ttsSettings?.voiceId).id,
      geminiContext: {
        sourceLanguage: project.sourceLanguage,
        targetLanguage: project.targetLanguage,
        original: cell.original,
        context: cell.context,
        cellLabel: cell.cellLabel,
      },
      session,
      username,
      diffusionSteps,
      onProgress,
    })
    setTtsStatus(statusKey, { kind: "idle" })
    return true
  } catch (e) {
    if (e instanceof AiModelConsentDeniedError) {
      setTtsStatus(statusKey, { kind: "idle" })
      return false
    }
    setTtsStatus(statusKey, { kind: "error", message: e instanceof Error ? e.message : String(e) })
    return false
  }
}

// Thin wrapper around generateAndAttachCellVoice that builds the synth args
// from a CellData + project + session and drives the per-cell tts status badge
// (the same status CellTtsButton shows). Used by the Voice Studio's per-cell
// and "Generate all" flows so every cell synthesizes identically.

import { generateAndAttachCellVoice } from "./generate-voice"
import { resolveCastVoice } from "./voices"
import { effectiveSourceText } from "@/lib/cell-text"
import { setTtsStatus, ttsStatusKey, synthesizeForCell } from "./tts"
import { AiModelConsentDeniedError } from "./ai-consent"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

export interface GenerateCellVoiceArgs {
  /**
   * AQU-646 stage 3: which TRACK this lands on, as a storage slot. Defaults to
   * the shipped one, so every existing caller is unchanged; an added track
   * passes its own id, and its one slot holds recorded and generated takes
   * alike.
   */
  slot?: string
  project: ProjectRecord
  cell: CellData
  session: FrontierSession | null
  username: string
  /** Voice to use. Falls back to the cell's, then the project default. */
  voiceId?: string
  /** Round 8c: the TTS take's permanent name (unset → backfilled later). */
  label?: string
  diffusionSteps?: number
  /**
   * AQU-646 stage 3f: the words to speak, when they are not the cell's own.
   *
   * On a file with an audio-cue sibling the translation lives on the SUBTITLE
   * cells — a cue carries only an English transcript of the soundtrack — so a
   * cue's own `translated` is empty forever and the button sat disabled over
   * lines that were, in fact, translated. The caller resolves the words across
   * the cue links (the same value read-aloud already shows the performer) and
   * passes them here.
   *
   * Absent ⇒ the cell's own text, exactly as before, so every other caller and
   * every other file arrangement is untouched.
   */
  text?: string
  /**
   * …and whose voice says them. Cast assignments are keyed by cell id and made
   * on the subtitle cells, so a cue has none of its own and would otherwise
   * speak in the project default whoever the character is. Absent ⇒ the cell's
   * own id, as before.
   */
  voiceCellId?: string
}

/**
 * Generate + durably attach a voice for one cell. Returns true on success,
 * false when the cell has no target text or generation was declined/failed
 * (status is surfaced via the per-cell tts badge, not thrown).
 */
export async function generateCellVoice(args: GenerateCellVoiceArgs): Promise<boolean> {
  const { project, cell, session, username, voiceId, label, diffusionSteps, slot } = args
  const text = (args.text ?? cell.translated)?.trim()
  // Not a failure — there is simply nothing to say. Every caller already gates
  // its control on the same emptiness, so this returns quietly, as before.
  if (!text) return false

  const statusKey = ttsStatusKey(cell.id)
  // AQU-646 stage 4c: A FAILURE HAS TO LEAVE A MARK. This used to return a
  // bare `false` from ABOVE the first status write, so a signed-out session
  // produced no status at all — the button went quiet and every surface
  // watching this cell went on showing whatever it had. It is the same
  // invisibility the rest of this stage is about, one branch earlier than the
  // catch that handles it. The consent-denied path below still returns false
  // with an IDLE status, on purpose: declining a model download is a choice,
  // not a fault, and must never paint anything red.
  if (!session?.jwt) {
    setTtsStatus(statusKey, {
      kind: "error",
      message: "Not signed in — sign in again to generate voice.",
    })
    return false
  }
  const onProgress: Parameters<typeof synthesizeForCell>[1]["onProgress"] = (p) => {
    setTtsStatus(statusKey, { kind: "loading", loaded: p.loaded, total: p.total, file: p.file })
    if (p.status === "ready" || (p.total > 0 && p.loaded >= p.total)) {
      setTtsStatus(statusKey, { kind: "synthesizing" })
    }
  }
  setTtsStatus(statusKey, { kind: "loading", loaded: 0, total: 0, file: "" })
  try {
    await generateAndAttachCellVoice({
      slot,
      projectId: project.id,
      fileId: cell.fileId,
      cellId: cell.id,
      text,
      projectTtsSettings: project.ttsSettings,
      // AQU-646: an explicit caller override wins; otherwise honor persisted
      // cast assignments (diarization's Speaker N → cell mapping) before the
      // cell's own voice, so batch + Voice Studio speak in the assigned voice.
      cellVoiceId:
        voiceId ??
        resolveCastVoice(
          project.ttsSettings,
          // The linked subtitle's assignment when there is one — see
          // `voiceCellId`. Falls back to this cell's own, which is every
          // non-cue arrangement.
          args.voiceCellId ?? cell.id,
          cell.ttsSettings?.voiceId,
        ).id,
      geminiContext: {
        sourceLanguage: project.sourceLanguage,
        targetLanguage: project.targetLanguage,
        // SUB-28: media sections speak through their transcript, not the filename.
        original: effectiveSourceText(cell),
        context: cell.context,
        cellLabel: cell.cellLabel,
      },
      session,
      username,
      diffusionSteps,
      ...(label ? { label } : {}),
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

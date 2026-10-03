// AQU-1109 "Change voice": re-voice a cell's EXISTING take into a cloned
// voice's timbre with Seed-VC. Never synthesizes from text — the words, timing
// and performance of the take are kept; only who it sounds like changes.
//
// Mirrors denoise-take: the result is a NEW take in the SAME slot as the take
// it came from, selected on attach; the source take stays in the strip and is
// linked from the new one's `referenceAudioId`.
//
// The worker names a converted clip `vc-<fingerprint>-q<steps>-audio-<cellId>-…`
// (sync-worker/src/voice-convert.ts `convertedAudioId`). The fingerprint is the
// reference clip it was made from, and `q` is the diffusion-step count the user
// picked. A re-run can tell a stale reference, or the same reference at a
// different quality, from a current one without a schema change. Clips named
// before quality was recorded (`vc-<fingerprint>-audio-…`) count as Fast.

import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { Voice } from "@/lib/parsers/types"
import { GENERATED_VOICE_SLOT, RECORDING_SLOT } from "@/lib/timeline/track-slots"
import { emitCellAudioAttach } from "@/lib/sync/events-emit"
import { probeDurationMsSafe } from "@/lib/import"
import { injectOptimisticAudioAttachment, notifyAudioAttachmentsChanged } from "./audio-attachments-bus"
import { audioCachePutBlob } from "./bytes-cache"
import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
import { setTtsStatus, ttsStatusKey } from "./tts"
import { fetchCellAudio, audioIdSeededWith } from "./upload"
import { convertToCloneVoice } from "./voice-clone"

const VOICE_CHANGED_PREFIX = "vc-"

/**
 * FNV-1a (32-bit) of a reference clip id, as 8 hex chars. Mirrors
 * `voiceReferenceFingerprint` in sync-worker/src/voice-convert.ts, which stamps
 * it into the converted clip's id. Change both or neither.
 */
export function voiceReferenceFingerprint(referenceAudioId: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < referenceAudioId.length; i++) {
    h ^= referenceAudioId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/** True when an audioId names a Change voice conversion. */
export function isVoiceChangedAudioId(audioId: string): boolean {
  return audioId.startsWith(VOICE_CHANGED_PREFIX)
}

/** True when `audioId` was converted from exactly this reference clip. */
export function voiceChangedWithReference(audioId: string, referenceAudioId: string): boolean {
  return audioId.startsWith(`${VOICE_CHANGED_PREFIX}${voiceReferenceFingerprint(referenceAudioId)}-`)
}

/** What the user picks. The numbers are Seed-VC diffusion steps: 10 is its fast
 *  range, 25 its normal default, 40 the high end of the useful range (50 is the
 *  worker's ceiling). */
export const CHANGE_VOICE_QUALITIES = ["fast", "standard", "high"] as const
export type ChangeVoiceQuality = (typeof CHANGE_VOICE_QUALITIES)[number]

export const CHANGE_VOICE_QUALITY_STEPS: Record<ChangeVoiceQuality, number> = {
  fast: 10,
  standard: 25,
  high: 40,
}

/** Steps assumed for a conversion named before quality was stamped into the id. */
export const LEGACY_CHANGE_VOICE_STEPS = CHANGE_VOICE_QUALITY_STEPS.fast

/** Diffusion steps recorded in a Change voice id, or null when it isn't one. */
export function voiceChangedSteps(audioId: string): number | null {
  const stamped = /^vc-[0-9a-f]{8}-q(\d+)-/.exec(audioId)
  if (stamped) return Number(stamped[1])
  if (isVoiceChangedAudioId(audioId)) return LEGACY_CHANGE_VOICE_STEPS
  return null
}

/** The quality a converted clip was made at, or null when the id isn't one.
 *  An unusual step count maps to the nearest named quality so the menu can
 *  still show it. */
export function changeVoiceQualityForSteps(steps: number | null): ChangeVoiceQuality | null {
  if (steps == null) return null
  let best: ChangeVoiceQuality = "standard"
  let dist = Infinity
  for (const quality of CHANGE_VOICE_QUALITIES) {
    const d = Math.abs(CHANGE_VOICE_QUALITY_STEPS[quality] - steps)
    if (d < dist) {
      dist = d
      best = quality
    }
  }
  return best
}

export interface ChangeVoiceTake {
  audioId: string
  slot: string
  attachment: CodexCellAttachment
}

function isImportedSourceClip(cell: CellData, audioId: string, att: CodexCellAttachment): boolean {
  if (att.role === "source") return true
  // A stub without `role`: a media cell's recording that isn't seeded with
  // the cell id is the shared programme clip (SUB-29).
  return cell.medium === "media" && audioId === cell.selectedAudioId && !audioIdSeededWith(audioId, cell.id)
}

/**
 * The take Change voice acts on: the cell's playable take (recording first,
 * then generated voice — the order the voice panel plays them in), never the
 * imported programme clip, whose object is the whole file's audio.
 */
export function changeVoiceSourceTake(cell: CellData): ChangeVoiceTake | null {
  for (const audioId of [cell.selectedAudioId, cell.selectedGeneratedVoiceAudioId]) {
    if (!audioId) continue
    const att = cell.attachments?.[audioId]
    if (!att || att.isDeleted) continue
    if (isImportedSourceClip(cell, audioId, att)) continue
    const slot = att.slot ?? (audioId === cell.selectedAudioId ? RECORDING_SLOT : GENERATED_VOICE_SLOT)
    return { audioId, slot, attachment: att }
  }
  return null
}

/**
 * Where a fresh Generate should land so it becomes the take you hear when the
 * one playing is a Change voice result.
 *
 * A converted take stays selected in the slot it was made in. Generate normally
 * writes the other slot (`generatedVoice`), and playback prefers a recording,
 * so the new synthesis never sounds and never becomes the circled take. Landing
 * it in the converted take's own slot selects it there and leaves the
 * conversion in the list underneath. A real recording is left alone — it is
 * meant to keep sounding over a generated voice.
 */
export function generateSlotOverVoiceChange(cell: CellData): string | undefined {
  const playing = changeVoiceSourceTake(cell)
  if (!playing || !isVoiceChangedAudioId(playing.audioId)) return undefined
  return playing.slot
}

/**
 * Walk back through earlier conversions to the take a person recorded,
 * imported or generated. Re-converting a conversion compounds artifacts, so a
 * re-run after a reference change always starts from the original. Stops at
 * the last take still present when the chain is broken.
 */
export function originalTakeId(
  attachments: Record<string, CodexCellAttachment> | undefined,
  audioId: string,
): string {
  let current = audioId
  for (let hops = 0; hops < 32 && isVoiceChangedAudioId(current); hops++) {
    const parent = attachments?.[current]?.referenceAudioId
    if (!parent || !attachments?.[parent] || attachments[parent].isDeleted) break
    current = parent
  }
  return current
}

/** Why Change voice can't run on a cell, or null when it can. */
export type ChangeVoiceBlocker = "no-take" | "not-cloned" | "up-to-date"

export function changeVoiceBlocker(
  cell: CellData,
  voice: Voice,
  /** When set, a take converted from the current reference at a DIFFERENT step
   *  count can be converted again. Omitted, any quality of the current
   *  reference counts as done. */
  diffusionSteps?: number,
): ChangeVoiceBlocker | null {
  const take = changeVoiceSourceTake(cell)
  if (!take) return "no-take"
  if (!voice.referenceAudioId) return "not-cloned"
  const sameVoice = take.attachment.voiceId === voice.id
    && voiceChangedWithReference(take.audioId, voice.referenceAudioId)
  const sameQuality = diffusionSteps == null || voiceChangedSteps(take.audioId) === diffusionSteps
  if (sameVoice && sameQuality) return "up-to-date"
  return null
}

/**
 * "Take 2 → Narrator": where the new take came from and whose voice it is now.
 * Undefined when the source take has no name yet — the takes strip backfills
 * unnamed takes with "Take N" itself.
 */
export function changeVoiceLabel(sourceLabel: string | null | undefined, voiceName: string): string | undefined {
  const from = sourceLabel?.trim()
  return from ? `${from} → ${voiceName}` : undefined
}

export interface ChangeVoiceArgs {
  projectId: string
  cell: CellData
  voice: Voice
  session: FrontierSession | null
  author: string
  /** The new take's permanent name. Defaults to `changeVoiceLabel`. */
  label?: string
  /** AQU-1462: lane the member is working in. Omitted for the default lane. */
  targetLang?: string
  diffusionSteps?: number
}

export interface ChangeVoiceResult {
  audioId: string
  url: string
}

/** Convert, attach and select. Throws on failure; see `changeCellVoice`. */
export async function changeVoiceForCell(args: ChangeVoiceArgs): Promise<ChangeVoiceResult> {
  const { projectId, cell, voice, session, author } = args
  if (!session?.jwt) throw new Error("Not signed in — sign in again to change the voice.")
  const take = changeVoiceSourceTake(cell)
  if (!take) throw new Error("This line has no take to change.")
  if (!voice.referenceAudioId) throw new Error(`${voice.name} has no reference clip — clone a voice first.`)

  const sourceAudioId = originalTakeId(cell.attachments, take.audioId)
  const label = args.label ?? changeVoiceLabel(cell.attachments?.[sourceAudioId]?.label, voice.name)
  const getSyncToken = audioSyncTokenFetcherForSession(session)
  const conv = await convertToCloneVoice({
    projectId,
    fileId: cell.fileId,
    cellId: cell.id,
    referenceAudioId: voice.referenceAudioId,
    sourceAudioId,
    diffusionSteps: args.diffusionSteps,
    getSyncToken,
  })

  const bytes = await fetchCellAudio({ projectId, fileId: cell.fileId, audioId: conv.audioId, ext: conv.ext, getSyncToken })
  const blob = new Blob([bytes as BlobPart], { type: "audio/wav" })
  void audioCachePutBlob(conv.audioId, conv.ext, blob)
  const durationMs = await probeDurationMsSafe(blob)
  const objectName = `${conv.audioId}.${conv.ext}`

  const attachEventId = await emitCellAudioAttach({
    projectId,
    fileId: cell.fileId,
    cellId: cell.id,
    audioId: objectName,
    url: conv.url,
    slot: take.slot,
    mimeType: "audio/wav",
    voiceId: voice.id,
    referenceAudioId: sourceAudioId,
    ...(durationMs != null ? { durationMs } : {}),
    ...(label ? { label } : {}),
    ...(args.targetLang ? { targetLang: args.targetLang } : {}),
    author,
  })
  injectOptimisticAudioAttachment(cell.fileId, cell.id, {
    audioId: objectName,
    url: conv.url,
    slot: take.slot,
    mimeType: "audio/wav",
    voiceId: voice.id,
    referenceAudioId: sourceAudioId,
    durationMs: durationMs ?? null,
    label: label ?? null,
    trimStartMs: null,
    trimEndMs: null,
  }, attachEventId)
  notifyAudioAttachmentsChanged(cell.fileId)
  return { audioId: objectName, url: conv.url }
}

/**
 * `changeVoiceForCell` behind the cell's tts badge — the same status the
 * generate button drives, so the spinner and the error popover (which already
 * knows Seed-VC failures) work unchanged. Returns true on success.
 */
export async function changeCellVoice(args: ChangeVoiceArgs): Promise<boolean> {
  const statusKey = ttsStatusKey(args.cell.id)
  setTtsStatus(statusKey, { kind: "synthesizing" })
  try {
    await changeVoiceForCell(args)
    setTtsStatus(statusKey, { kind: "idle" })
    return true
  } catch (e) {
    setTtsStatus(statusKey, { kind: "error", message: e instanceof Error ? e.message : String(e) })
    return false
  }
}

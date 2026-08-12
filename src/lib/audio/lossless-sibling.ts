/**
 * lossless-sibling — the "same id, two extensions" convention for generated
 * voices.
 *
 * Client-synthesized TTS uploads compressed (webm/opus) and attaches ONLY the
 * compressed object; the original WAV is uploaded best-effort under the SAME
 * base audioId with ext "wav". The sibling gets no cell_audio row on purpose:
 * a second attachment would surface as a duplicate take in the strip and fight
 * the slot's selected flag. It is found by convention — swap the parsed ext
 * for "wav" — and consumed by the playback-quality preference (play "original"
 * when the listener asks for it) and by exports (always prefer lossless).
 *
 * Lifecycle: the sibling lives exactly as long as the compressed object.
 * There is no user-facing R2 delete for generated voices (take "delete" is a
 * soft projection remove), and the admin file-delete sweeps the whole
 * `.../audio/` prefix, which wipes both. No delete pairing is needed.
 *
 * Presence is memoized per audioId. "present" is true forever (ids are
 * immutable and the mark follows a completed upload). "missing" is true
 * forever with ONE narrow exception: a probe can race another device's
 * still-in-flight sibling upload (it is fire-and-forget and 14× the
 * compressed bytes), pinning that listener to compressed for the session —
 * heals on reload; the generating device itself self-corrects via
 * markLosslessSiblingPresent. Accepted deliberately: not memoizing "missing"
 * would instead cost a probe on EVERY playback start of every clip that
 * genuinely has no sibling (all pre-convention clips, forever). "unknown"
 * (offline, blip) is deliberately NOT memoized — caching it would turn a
 * one-request blip into a session-long quality downgrade.
 *
 * NOTE: eligibility (is this attachment a client-synth generated voice?) is
 * the CALLER's job — the convention here assumes it. Callers derive it from
 * `cell.selectedGeneratedVoiceAudioId === "<audioId>.<ext>"`; if that
 * projection convention ever changes, the toggle silently disables (never
 * breaks).
 */

import { getAudioQualityPref } from "@/lib/store/audio-quality-pref"
import {
  probeCellAudioPresent,
  uploadCellAudio,
  type SyncTokenForFile,
} from "./upload"

const LOSSLESS_EXT = "wav"

/** Compressed primary ext the sibling convention applies to. */
const COMPRESSED_EXT = "webm"

/** audioId → settled presence. Only "present"/"missing" ever land here. */
const presenceMemo = new Map<string, boolean>()

/** audioId → in-flight probe, so concurrent resolvers share one request. */
const inFlight = new Map<string, Promise<boolean>>()

interface SiblingArgs {
  projectId: string
  fileId: string
  audioId: string
  getSyncToken: SyncTokenForFile
}

/** Record that a sibling exists without probing — generation calls this after
 *  a successful sibling upload so fresh clips never pay a probe. */
export function markLosslessSiblingPresent(audioId: string): void {
  presenceMemo.set(audioId, true)
}

/** Does `<audioId>.wav` exist next to the compressed object? */
export function losslessSiblingPresent(args: SiblingArgs): Promise<boolean> {
  const known = presenceMemo.get(args.audioId)
  if (known !== undefined) return Promise.resolve(known)
  const running = inFlight.get(args.audioId)
  if (running) return running
  const probe = probeCellAudioPresent({
    projectId: args.projectId,
    fileId: args.fileId,
    audioId: args.audioId,
    ext: LOSSLESS_EXT,
    getSyncToken: args.getSyncToken,
  })
    .then((presence) => {
      if (presence !== "unknown") presenceMemo.set(args.audioId, presence === "present")
      return presence === "present"
    })
    .finally(() => {
      inFlight.delete(args.audioId)
    })
  inFlight.set(args.audioId, probe)
  return probe
}

/** Upload the original WAV next to an already-uploaded compressed object.
 *  Best-effort by contract: warns and returns false on any failure (including
 *  the size-cap throw inside uploadCellAudio) — the generation that queued it
 *  must never fail or slow down because the lossless copy didn't land. */
export async function uploadLosslessSiblingBestEffort(
  args: SiblingArgs & { wavBlob: Blob },
): Promise<boolean> {
  try {
    await uploadCellAudio({
      projectId: args.projectId,
      fileId: args.fileId,
      audioId: args.audioId,
      ext: LOSSLESS_EXT,
      blob: args.wavBlob,
      getSyncToken: args.getSyncToken,
    })
    markLosslessSiblingPresent(args.audioId)
    return true
  } catch (e) {
    console.warn(
      "[lossless-sibling] WAV sibling upload failed — playback/export fall back to compressed",
      e,
    )
    return false
  }
}

/** The ext playback should fetch for an attachment, honoring the device
 *  quality preference. Returns the attachment's own ext unless the caller
 *  says this is a generated voice, the primary is compressed, the user asked
 *  for original quality, and the sibling actually exists. */
export async function preferredPlaybackExt(
  args: SiblingArgs & { attachmentExt: string; eligible: boolean },
): Promise<string> {
  if (!args.eligible) return args.attachmentExt
  if (args.attachmentExt !== COMPRESSED_EXT) return args.attachmentExt
  if (getAudioQualityPref() !== "original") return args.attachmentExt
  return (await losslessSiblingPresent(args)) ? LOSSLESS_EXT : args.attachmentExt
}

/** Test helper: forget all memoized presence + in-flight probes. */
export function resetLosslessSiblingMemoForTests(): void {
  presenceMemo.clear()
  inFlight.clear()
}

// AQU-646: build a voice-clone reference clip from time ranges of an imported
// media file. Diarization gives each speaker's turns within the ONE shared
// clip an import produces; slicing the speaker's clearest material into a
// short reference lets the existing Seed-VC pipeline speak the target text in
// the imported speaker's voice — no separate recording/upload step.
//
// Pipeline: fetch the full clip (references must be stored clips; trims are
// non-destructive playback metadata) → decode to mono 48k → take the LONGEST
// ranges first up to MAX_REFERENCE_SEC → concat → 16-bit WAV → upload as a
// project-scoped reference. Seed-VC only reads the first ~25s of a reference
// (infra/modal/seed_vc.py caps at sr*25), so 20s is a comfortable target well
// under the UI's 8 MB cap (20s mono 48k/16-bit ≈ 1.9 MB).

import { fetchCellAudio, parseFrontierAudioUrl } from "./upload"
import { decodeToMono48k, TARGET_RATE } from "./decode-mono"
import { concatPcm } from "@/lib/export/audio-by-character"
import { encodeWavPcm16 } from "./wav-encode"
import { uploadVoiceReference, buildVoiceReferenceId } from "./voice-clone"

/** Cap the assembled reference; Seed-VC ignores material past ~25s anyway. */
export const MAX_REFERENCE_SEC = 20
/** Ignore ranges too short to carry usable voice character. */
const MIN_RANGE_SEC = 0.5

export interface ReferenceRange {
  startMs: number
  endMs: number
}

export interface ExtractVoiceReferenceArgs {
  projectId: string
  fileId: string
  /** frontier-audio:// url of the shared imported clip (any segment's attachment url). */
  clipUrl: string
  /** Speaker's ranges within the clip (e.g. diarization turns). */
  ranges: ReferenceRange[]
  getSyncToken: (projectId: string, fileId: string) => Promise<string | null>
  /** Test seams. */
  fetchBytes?: (args: { projectId: string; fileId: string; audioId: string; ext: string; getSyncToken: ExtractVoiceReferenceArgs["getSyncToken"] }) => Promise<Uint8Array>
  decode?: (bytes: Uint8Array) => Promise<Float32Array>
  upload?: typeof uploadVoiceReference
}

/**
 * Pure helper (exported for tests): pick the longest ranges up to the cap and
 * slice+concat them out of a mono PCM buffer. Ranges are clamped to the clip;
 * sub-`MIN_RANGE_SEC` ranges are skipped; result order is chronological so the
 * reference sounds natural.
 */
export function slicePcmForReference(
  pcm: Float32Array,
  ranges: ReferenceRange[],
  sampleRate: number = TARGET_RATE,
  maxSec: number = MAX_REFERENCE_SEC,
): Float32Array {
  const clipMs = (pcm.length / sampleRate) * 1000
  const usable = ranges
    .map((r) => ({
      startMs: Math.max(0, Math.min(clipMs, r.startMs)),
      endMs: Math.max(0, Math.min(clipMs, r.endMs)),
    }))
    .filter((r) => r.endMs - r.startMs >= MIN_RANGE_SEC * 1000)
  // Longest-first selection, chronological assembly.
  const byLength = [...usable].sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs))
  const picked: ReferenceRange[] = []
  let totalMs = 0
  for (const r of byLength) {
    if (totalMs >= maxSec * 1000) break
    const remaining = maxSec * 1000 - totalMs
    const take = Math.min(r.endMs - r.startMs, remaining)
    picked.push({ startMs: r.startMs, endMs: r.startMs + take })
    totalMs += take
  }
  picked.sort((a, b) => a.startMs - b.startMs)
  const clips = picked.map((r) => {
    const s = Math.round((r.startMs / 1000) * sampleRate)
    const e = Math.round((r.endMs / 1000) * sampleRate)
    return pcm.slice(s, Math.max(s, e))
  })
  if (clips.length === 0) return new Float32Array(0)
  return concatPcm(clips)
}

/**
 * Extract a reference clip for one speaker and upload it. Returns the new
 * `referenceAudioId` to set on a Voice, or null when the ranges yield no
 * usable audio. Throws on fetch/decode/upload failure — callers treat a
 * failure as "voice stays reference-less" (today's behavior).
 */
export async function extractVoiceReference(args: ExtractVoiceReferenceArgs): Promise<string | null> {
  const frontier = parseFrontierAudioUrl(args.clipUrl)
  if (!frontier) return null

  const fetchBytes = args.fetchBytes ?? fetchCellAudio
  const decode = args.decode ?? decodeToMono48k
  const upload = args.upload ?? uploadVoiceReference

  const bytes = await fetchBytes({
    projectId: args.projectId,
    fileId: args.fileId,
    audioId: frontier.audioId,
    ext: frontier.ext,
    getSyncToken: args.getSyncToken,
  })
  const pcm = await decode(bytes)
  const sliced = slicePcmForReference(pcm, args.ranges)
  if (sliced.length === 0) return null

  const blob = encodeWavPcm16(sliced, TARGET_RATE)
  const referenceAudioId = buildVoiceReferenceId("wav")
  await upload({
    projectId: args.projectId,
    fileId: args.fileId,
    referenceAudioId,
    blob,
    getSyncToken: args.getSyncToken,
  })
  return referenceAudioId
}

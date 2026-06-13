// Client lib for the OmniVoice TTS endpoint (sync-worker).
//
// Mirrors voice-clone.ts (convertToCloneVoice): uses syncWorkerHttpOrigin() for
// the base URL and a sync token (scoped to projectId+fileId) for auth.
//
// The returned audioId is a valid cell-audio object in R2 — callers can:
//   (a) emit cell.audio.attach directly with the audioId (use case 1), or
//   (b) pass audioId as sourceAudioId to /api/v1/voice/convert (use case 3).

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import type { SyncTokenForFile } from "../audio/upload"

export interface SynthesizeCellTtsArgs {
  projectId: string
  fileId: string
  /** Optional: narrows the R2 object key to this cell. */
  cellId?: string
  /** The text to synthesize. */
  text: string
  /** Reference clip id for voice cloning (from /api/v1/voice/reference/*). */
  referenceAudioId?: string
  /** BCP-47 language tag. */
  language?: string
}

export interface SynthesizeCellTtsResult {
  /** Frontier audio id — valid cell-audio object in R2 (e.g. "abc123.wav"). */
  audioId: string
  /** Duration of the generated clip in seconds. */
  durationSeconds: number
}

/**
 * POST /api/v1/voice/tts on the sync-worker and return the stored audioId and
 * duration. The sync token (scoped to projectId + fileId) is fetched via
 * getSyncToken, mirroring the voice-convert client call.
 *
 * Throws on any non-OK response (including 429 budget-exceeded).
 */
export async function synthesizeCellTts(
  args: SynthesizeCellTtsArgs,
  getSyncToken: SyncTokenForFile,
): Promise<SynthesizeCellTtsResult> {
  const token = await getSyncToken(args.projectId, args.fileId)
  if (!token) throw new Error("synthesizeCellTts: no sync token")

  const body: Record<string, string> = {
    projectId: args.projectId,
    fileId: args.fileId,
    text: args.text,
  }
  if (args.cellId !== undefined) body.cellId = args.cellId
  if (args.referenceAudioId !== undefined) body.referenceAudioId = args.referenceAudioId
  if (args.language !== undefined) body.language = args.language

  const res = await fetch(`${syncWorkerHttpOrigin()}/api/v1/voice/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`voice/tts failed (${res.status}): ${text || res.statusText}`)
  }

  return (await res.json()) as SynthesizeCellTtsResult
}

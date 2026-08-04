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
  /** Bare audio id, NO extension (e.g. "audio-tts-123-ab12cd34"). For the
   * cell-audio attach use `objectName`/`url` below — `audioId` alone is not a
   * resolvable R2 key or frontier-audio:// pointer. */
  audioId: string
  /** Duration of the generated clip in seconds. */
  durationSeconds: number
  /** R2 object name WITH extension (e.g. "audio-tts-123-ab12cd34.wav"). This is
   * the value to pass as the cell-audio `audioId` so the /audio route resolves. */
  objectName: string
  /** Canonical pointer (e.g. "frontier-audio://audio-tts-123-ab12cd34.wav"). Use
   * as the cell-audio `url`; `parseFrontierAudioUrl` requires the extension. */
  url: string
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
    const detail = (await res.text().catch(() => "")) || res.statusText
    // Name the engine and keep the status code so the UI can categorize the
    // failure (categorizeAiError → "tts-provider-unavailable"): a 503 means
    // OmniVoice isn't configured for this environment, a 502 an upstream
    // synthesis/clone failure. An unlabeled "voice/tts failed" read to users
    // as "nothing happened" — the silent-clone bug in AQU-788.
    throw new Error(`OmniVoice voice/tts failed (${res.status}): ${detail}`)
  }

  return (await res.json()) as SynthesizeCellTtsResult
}

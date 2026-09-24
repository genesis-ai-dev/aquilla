// Client lib for the hosted Inworld TTS endpoint (sync-worker).
//
// Mirrors voice-clone.ts (convertToCloneVoice): uses syncWorkerHttpOrigin() for
// the base URL and a sync token (scoped to projectId+fileId) for auth.
//
// The returned audioId is a valid cell-audio object in R2 — callers can:
//   (a) emit cell.audio.attach directly with the audioId (use case 1), or
//   (b) pass audioId as sourceAudioId to /api/v1/voice/convert (use case 3).

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import { timeoutSignal } from "./fetch-timeout"
import {
  TTS_REQUEST_TIMEOUT_MS,
  errorFromHostedTts,
  errorFromTtsTimeout,
  isAbortTimeout,
} from "@/lib/audio/tts-engine-error"
import { parseInworldSupportedLanguages } from "@/lib/audio/inworld-supported-languages"
import type { SyncTokenForFile } from "../audio/upload"

export interface SynthesizeCellTtsArgs {
  projectId: string
  fileId: string
  /** Optional: narrows the R2 object key to this cell. */
  cellId?: string
  /** The text to synthesize. */
  text: string
  /** Inworld stock voice id (e.g. "Dennis") or a previously cloned voiceId. */
  voiceId?: string
  /** Reference clip id for voice cloning (from /api/v1/voice/reference/*). */
  referenceAudioId?: string
  /** BCP-47 language tag. */
  language?: string
  /** Talking speed in [0.5, 1.5]. */
  speakingRate?: number
  /** STABLE | BALANCED | CREATIVE. Honored only on Highest quality (inworld-tts-2). */
  deliveryMode?: "STABLE" | "BALANCED" | "CREATIVE"
  /** Standard = Flash; Highest = TTS-2. */
  audioQuality?: "standard" | "highest"
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

  const body: Record<string, string | number> = {
    projectId: args.projectId,
    fileId: args.fileId,
    text: args.text,
  }
  if (args.cellId !== undefined) body.cellId = args.cellId
  if (args.voiceId !== undefined) body.voiceId = args.voiceId
  if (args.referenceAudioId !== undefined) body.referenceAudioId = args.referenceAudioId
  if (args.language !== undefined) body.language = args.language
  if (args.speakingRate !== undefined) body.speakingRate = args.speakingRate
  if (args.deliveryMode !== undefined) body.deliveryMode = args.deliveryMode
  if (args.audioQuality !== undefined) body.audioQuality = args.audioQuality

  // AQU-1156: bounded. `timeoutSignal` is the shared older-WebKit guard (see
  // fetch-timeout.ts) — where AbortSignal.timeout is missing it returns
  // undefined and we degrade to the browser socket timeout rather than losing
  // the request entirely.
  let res: Response
  try {
    res = await fetch(`${syncWorkerHttpOrigin()}/api/v1/voice/tts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: timeoutSignal(TTS_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    if (isAbortTimeout(err)) throw errorFromTtsTimeout("Inworld TTS", TTS_REQUEST_TIMEOUT_MS)
    throw err
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw errorFromHostedTts(res.status, text || res.statusText)
  }

  return (await res.json()) as SynthesizeCellTtsResult
}

export interface InworldCatalogVoice {
  voiceId: string
  displayName: string
  language: string
  description?: string
}

/**
 * GET /api/v1/voice/tts/voices — Inworld SYSTEM voices for the given
 * target-language lanes. Pass `all: true` for every SYSTEM voice.
 * The sync token is project-scoped; fileId is only needed to mint it.
 */
export async function listInworldVoices(
  args: { projectId: string; fileId: string; languages: readonly string[]; all?: boolean },
  getSyncToken: SyncTokenForFile,
): Promise<InworldCatalogVoice[]> {
  const token = await getSyncToken(args.projectId, args.fileId)
  if (!token) throw new Error("listInworldVoices: no sync token")

  const params = new URLSearchParams({ projectId: args.projectId })
  if (args.all) {
    params.set("all", "1")
  } else {
    for (const language of args.languages) {
      const trimmed = language.trim()
      if (trimmed) params.append("language", trimmed)
    }
  }

  const res = await fetch(`${syncWorkerHttpOrigin()}/api/v1/voice/tts/voices?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw errorFromHostedTts(res.status, text || res.statusText)
  }
  const json = (await res.json()) as { voices?: InworldCatalogVoice[] }
  return Array.isArray(json.voices) ? json.voices : []
}

export interface InworldSupportedLanguageRow {
  code: string
  familyCode: string
  familyDisplayName: string
  accentDisplayName: string
  displayName: string
  creationEnabled: boolean
  hasVoices: boolean
}

/**
 * GET /api/v1/voice/tts/supported-languages — Inworld Voice Design catalog
 * (family + accent). The sync token is project-scoped; fileId is only needed
 * to mint it.
 */
export async function listInworldSupportedLanguages(
  args: { projectId: string; fileId: string },
  getSyncToken: SyncTokenForFile,
): Promise<InworldSupportedLanguageRow[]> {
  const token = await getSyncToken(args.projectId, args.fileId)
  if (!token) throw new Error("listInworldSupportedLanguages: no sync token")

  const params = new URLSearchParams({ projectId: args.projectId })
  const res = await fetch(
    `${syncWorkerHttpOrigin()}/api/v1/voice/tts/supported-languages?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw errorFromHostedTts(res.status, text || res.statusText)
  }
  const json = (await res.json()) as { languages?: unknown }
  return parseInworldSupportedLanguages(json)
}

export interface DesignInworldVoiceArgs {
  projectId: string
  fileId: string
  designPrompt: string
  previewText?: string
  language?: string
  numberOfSamples?: number
  designPromptMode?: "DESIGN_PROMPT_MODE_ASSISTED" | "DESIGN_PROMPT_MODE_VERBATIM"
}

export interface InworldDesignedPreview {
  voiceId: string
  previewText: string
  previewAudio: string
}

/**
 * POST /api/v1/voice/tts/design — generate up to three Voice Design previews.
 * The sync token is project-scoped; fileId is only needed to mint it.
 */
export async function designInworldVoice(
  args: DesignInworldVoiceArgs,
  getSyncToken: SyncTokenForFile,
): Promise<InworldDesignedPreview[]> {
  const token = await getSyncToken(args.projectId, args.fileId)
  if (!token) throw new Error("designInworldVoice: no sync token")

  const body: Record<string, string | number> = {
    projectId: args.projectId,
    designPrompt: args.designPrompt,
  }
  if (args.previewText !== undefined) body.previewText = args.previewText
  if (args.language !== undefined) body.language = args.language
  if (args.numberOfSamples !== undefined) body.numberOfSamples = args.numberOfSamples
  if (args.designPromptMode !== undefined) body.designPromptMode = args.designPromptMode

  const res = await fetch(`${syncWorkerHttpOrigin()}/api/v1/voice/tts/design`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw errorFromHostedTts(res.status, text || res.statusText)
  }
  const json = (await res.json()) as { previewVoices?: InworldDesignedPreview[] }
  return Array.isArray(json.previewVoices) ? json.previewVoices : []
}

export interface PublishInworldVoiceArgs {
  projectId: string
  fileId: string
  voiceId: string
  displayName?: string
  description?: string
}

/**
 * POST /api/v1/voice/tts/publish — promote a Voice Design preview into the
 * workspace library so later synthesize calls can use its voiceId.
 */
export async function publishInworldVoice(
  args: PublishInworldVoiceArgs,
  getSyncToken: SyncTokenForFile,
): Promise<string> {
  const token = await getSyncToken(args.projectId, args.fileId)
  if (!token) throw new Error("publishInworldVoice: no sync token")

  const body: Record<string, string> = {
    projectId: args.projectId,
    voiceId: args.voiceId,
  }
  if (args.displayName !== undefined) body.displayName = args.displayName
  if (args.description !== undefined) body.description = args.description

  const res = await fetch(`${syncWorkerHttpOrigin()}/api/v1/voice/tts/publish`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw errorFromHostedTts(res.status, text || res.statusText)
  }
  const json = (await res.json()) as { voiceId?: string }
  return json.voiceId?.trim() || args.voiceId
}

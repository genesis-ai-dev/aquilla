// Client for sync-worker's /api/v1/elevenlabs/* routes (AQU-2299, BYOK).
//
// Every call carries two credentials: the usual sync token (project/file
// scope, Authorization) and the user's own ElevenLabs key (X-ElevenLabs-Key),
// read from this device's storage (src/lib/audio/elevenlabs/key.ts). The key is
// never put in a URL and never sent anywhere but our own sync-worker.
//
// Results deliberately reuse the hosted engines' shapes so callers barely
// change: synthesis returns `SynthesizeCellTtsResult` (as /voice/tts) and
// speech-to-speech returns `ConvertToLibraryVoiceResult` (as /voice/convert).

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import { timeoutSignal } from "./fetch-timeout"
import { TTS_REQUEST_TIMEOUT_MS, errorFromTtsTimeout, isAbortTimeout } from "@/lib/audio/tts-engine-error"
import { errorFromElevenLabs, elevenLabsKeyMissingError } from "@/lib/audio/elevenlabs/errors"
import { getElevenLabsKey } from "@/lib/audio/elevenlabs/key"
import { buildVoiceReferenceId, uploadVoiceReference, type ConvertToLibraryVoiceResult } from "@/lib/audio/voice-clone"
import { CUSTOM_VOICE_CONSENT_VERSION } from "@/lib/audio/custom-voice"
import type { ElevenLabsVoiceSettings } from "@/lib/parsers/types"
import type { SyncTokenForFile } from "@/lib/audio/upload"
import type { SynthesizeCellTtsResult } from "./tts"

/** The header sync-worker reads the key from (ELEVENLABS_KEY_HEADER). */
export const ELEVENLABS_KEY_HEADER = "X-ElevenLabs-Key"

/** Cloning uploads every sample upstream in one request — give it longer. */
const CLONE_TIMEOUT_MS = 150_000
const READ_TIMEOUT_MS = 20_000

/**
 * Project-scoped calls (account, voice browser, clone) work from places with
 * no open file — Project settings, a fresh project's New voice. The sync token
 * is project-scoped on those routes; this stands in for the file it is minted
 * for (the mint only checks the id is path-safe).
 */
export const ELEVENLABS_PROJECT_SCOPE_FILE_ID = "_elevenlabs"

export interface ElevenLabsScope {
  projectId: string
  /** Any file in the project; absent → the project-scope placeholder. */
  fileId?: string | null
  /** Explicit key (the Connect card validating a pasted key); else this device's. */
  apiKey?: string
}

function resolveKey(explicit?: string): string {
  const key = (explicit ?? getElevenLabsKey())?.trim()
  if (!key) throw elevenLabsKeyMissingError()
  return key
}

async function authHeaders(scope: ElevenLabsScope, getSyncToken: SyncTokenForFile): Promise<Record<string, string>> {
  const key = resolveKey(scope.apiKey)
  const token = await getSyncToken(scope.projectId, scope.fileId || ELEVENLABS_PROJECT_SCOPE_FILE_ID)
  if (!token) throw new Error("ElevenLabs: no sync token — sign in again.")
  return { Authorization: `Bearer ${token}`, [ELEVENLABS_KEY_HEADER]: key }
}

async function send(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: timeoutSignal(timeoutMs) })
  } catch (err) {
    if (isAbortTimeout(err)) throw errorFromTtsTimeout("ElevenLabs", timeoutMs)
    throw err
  }
  if (!res.ok) throw errorFromElevenLabs(res.status, await res.text().catch(() => ""))
  return res
}

const base = () => `${syncWorkerHttpOrigin()}/api/v1/elevenlabs`

// ── Reads ────────────────────────────────────────────────────────────────────

export interface ElevenLabsAccount {
  tier: string
  characterCount: number
  characterLimit: number
  canClone: boolean
  resetAtUnix: number | null
}

/** GET /api/v1/elevenlabs/user — also how a pasted key is validated. */
export async function fetchElevenLabsAccount(
  scope: ElevenLabsScope,
  getSyncToken: SyncTokenForFile,
): Promise<ElevenLabsAccount> {
  const params = new URLSearchParams({ projectId: scope.projectId })
  const res = await send(`${base()}/user?${params}`, { headers: await authHeaders(scope, getSyncToken) }, READ_TIMEOUT_MS)
  return (await res.json()) as ElevenLabsAccount
}

export type ElevenLabsVoiceCategory = "premade" | "cloned" | "generated" | "professional"

export interface ElevenLabsVoiceRow {
  id: string
  name: string
  category: ElevenLabsVoiceCategory
  labels: Record<string, string>
  previewUrl: string | null
  description: string | null
}

export interface ElevenLabsVoicePage {
  voices: ElevenLabsVoiceRow[]
  nextPageToken: string | null
}

/** GET /api/v1/elevenlabs/voices — the account's voices (v2 search). */
export async function listElevenLabsVoices(
  scope: ElevenLabsScope & { search?: string; category?: ElevenLabsVoiceCategory; pageToken?: string },
  getSyncToken: SyncTokenForFile,
): Promise<ElevenLabsVoicePage> {
  const params = new URLSearchParams({ projectId: scope.projectId })
  if (scope.search?.trim()) params.set("search", scope.search.trim())
  if (scope.category) params.set("category", scope.category)
  if (scope.pageToken) params.set("pageToken", scope.pageToken)
  const res = await send(`${base()}/voices?${params}`, { headers: await authHeaders(scope, getSyncToken) }, READ_TIMEOUT_MS)
  const json = (await res.json()) as Partial<ElevenLabsVoicePage>
  return { voices: Array.isArray(json.voices) ? json.voices : [], nextPageToken: json.nextPageToken ?? null }
}

/** GET /api/v1/elevenlabs/models — the curated TTS models this account has. */
export async function listElevenLabsModels(scope: ElevenLabsScope, getSyncToken: SyncTokenForFile): Promise<string[]> {
  const params = new URLSearchParams({ projectId: scope.projectId })
  const res = await send(`${base()}/models?${params}`, { headers: await authHeaders(scope, getSyncToken) }, READ_TIMEOUT_MS)
  const json = (await res.json()) as { models?: { id: string }[] }
  return (json.models ?? []).map((m) => m.id)
}

// ── Audio ────────────────────────────────────────────────────────────────────

export interface ElevenLabsTtsArgs {
  projectId: string
  fileId: string
  cellId?: string
  text: string
  voiceId: string
  modelId?: string
  voiceSettings?: ElevenLabsVoiceSettings
  /** ISO 639-1; ignored by Multilingual v2. */
  languageCode?: string
}

function ttsBody(args: ElevenLabsTtsArgs, preview: boolean): string {
  return JSON.stringify({
    projectId: args.projectId,
    fileId: args.fileId,
    text: args.text,
    voiceId: args.voiceId,
    ...(args.cellId ? { cellId: args.cellId } : {}),
    ...(args.modelId ? { modelId: args.modelId } : {}),
    ...(args.voiceSettings ? { voiceSettings: args.voiceSettings } : {}),
    ...(args.languageCode ? { languageCode: args.languageCode } : {}),
    ...(preview ? { preview: true } : {}),
  })
}

/** POST /api/v1/elevenlabs/tts — the worker stores the mp3 and returns its id. */
export async function synthesizeElevenLabsTts(
  args: ElevenLabsTtsArgs,
  getSyncToken: SyncTokenForFile,
): Promise<SynthesizeCellTtsResult> {
  const headers = await authHeaders({ projectId: args.projectId, fileId: args.fileId }, getSyncToken)
  const res = await send(
    `${base()}/tts`,
    { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: ttsBody(args, false) },
    TTS_REQUEST_TIMEOUT_MS,
  )
  return (await res.json()) as SynthesizeCellTtsResult
}

/** POST /api/v1/elevenlabs/tts with `preview: true` — the audio, nothing stored. */
export async function previewElevenLabsTts(
  args: ElevenLabsTtsArgs,
  getSyncToken: SyncTokenForFile,
): Promise<Blob> {
  const headers = await authHeaders({ projectId: args.projectId, fileId: args.fileId }, getSyncToken)
  const res = await send(
    `${base()}/tts`,
    { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: ttsBody(args, true) },
    TTS_REQUEST_TIMEOUT_MS,
  )
  return new Blob([await res.arrayBuffer()], { type: "audio/mpeg" })
}

export interface ElevenLabsStsArgs {
  projectId: string
  fileId: string
  cellId: string
  voiceId: string
  /** An existing cell-audio object under this file to re-voice. */
  sourceAudioId?: string
  /** Or fresh audio. */
  source?: Blob
  modelId?: string
  voiceSettings?: ElevenLabsVoiceSettings
}

/** POST /api/v1/elevenlabs/sts — a converted take with /voice/convert's contract. */
export async function convertElevenLabsSpeech(
  args: ElevenLabsStsArgs,
  getSyncToken: SyncTokenForFile,
): Promise<ConvertToLibraryVoiceResult> {
  if (!args.source && !args.sourceAudioId) throw new Error("ElevenLabs: provide a source take to convert")
  const headers = await authHeaders({ projectId: args.projectId, fileId: args.fileId }, getSyncToken)
  const form = new FormData()
  form.append("projectId", args.projectId)
  form.append("fileId", args.fileId)
  form.append("cellId", args.cellId)
  form.append("voiceId", args.voiceId)
  if (args.modelId) form.append("modelId", args.modelId)
  if (args.voiceSettings) form.append("voiceSettings", JSON.stringify(args.voiceSettings))
  if (args.sourceAudioId) form.append("sourceAudioId", args.sourceAudioId)
  if (args.source) form.append("source", args.source, "source")
  const res = await send(`${base()}/sts`, { method: "POST", headers, body: form }, TTS_REQUEST_TIMEOUT_MS)
  return (await res.json()) as ConvertToLibraryVoiceResult
}

export interface CloneElevenLabsVoiceArgs {
  projectId: string
  fileId?: string | null
  name: string
  recordings: Blob[]
  removeBackgroundNoise: boolean
  description?: string
  /** The maintainer ticked the consent statement. */
  consentConfirmed: boolean
  onProgress?: (uploaded: number, total: number) => void
}

export interface ClonedElevenLabsVoice {
  voiceId: string
  requiresVerification: boolean
  attestedAt: string
  statementVersion: string
}

function extOf(blob: Blob): string {
  const named = blob instanceof File ? blob.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") : ""
  if (named) return named
  const sub = blob.type.split("/")[1]?.split(";")[0]?.replace(/[^a-z0-9]/g, "")
  return sub || "webm"
}

/**
 * Upload the samples to the project's reference store (the same one custom-voice
 * training reads), then ask the worker to record consent and create the
 * Instant Voice Clone in the user's own ElevenLabs account.
 */
export async function cloneElevenLabsVoice(
  args: CloneElevenLabsVoiceArgs,
  getSyncToken: SyncTokenForFile,
): Promise<ClonedElevenLabsVoice> {
  if (!args.consentConfirmed) throw new Error("Confirm the speaker's consent before cloning a voice.")
  // Fail on a missing key before uploading anything.
  resolveKey()
  const fileId = args.fileId || ELEVENLABS_PROJECT_SCOPE_FILE_ID
  const referenceAudioIds: string[] = []
  for (const [i, blob] of args.recordings.entries()) {
    const referenceAudioId = buildVoiceReferenceId(extOf(blob))
    await uploadVoiceReference({ projectId: args.projectId, fileId, referenceAudioId, blob, getSyncToken })
    referenceAudioIds.push(referenceAudioId)
    args.onProgress?.(i + 1, args.recordings.length)
  }
  const headers = await authHeaders({ projectId: args.projectId, fileId }, getSyncToken)
  const res = await send(
    `${base()}/clone`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: args.projectId,
        name: args.name,
        referenceAudioIds,
        removeBackgroundNoise: args.removeBackgroundNoise,
        ...(args.description ? { description: args.description } : {}),
        consent: { confirmed: true, statementVersion: CUSTOM_VOICE_CONSENT_VERSION },
      }),
    },
    CLONE_TIMEOUT_MS,
  )
  return (await res.json()) as ClonedElevenLabsVoice
}

// Custom voices: train an RVC voice model from the organization's own recordings
// of a real speaker (sync-worker /api/v1/voice/custom/*, infra/modal/voice_forge.py).
// Once ready it behaves like a character voice — Change voice re-voices takes into
// it — so the cast Voice simply carries its id in `libraryVoiceId`.
//
// Consent is the organization's responsibility. The UI makes a maintainer confirm
// the statement below; the worker refuses to train without it and keeps the
// confirmation (who, when, which statement, which recordings) as an audit record.

import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import type { Voice } from "@/lib/parsers/types"
import type { SyncTokenForFile } from "./upload"
import { buildVoiceReferenceId, uploadVoiceReference } from "./voice-clone"

/** Mirrors CUSTOM_VOICE_CONSENT_VERSION in sync-worker/src/custom-voice.ts. */
export const CUSTOM_VOICE_CONSENT_VERSION = "2026-10-23"
/**
 * The exact statement the server records, shown in full behind "Read the full
 * statement". Kept in English: it is the wording stored in the audit record.
 * Mirrors CUSTOM_VOICE_CONSENT_STATEMENT in sync-worker/src/custom-voice.ts.
 */
export const CUSTOM_VOICE_CONSENT_STATEMENT =
  "My organization has the informed consent of the person whose voice is in these recordings " +
  "to create an AI model of their voice and to use it in this project, and this use complies " +
  "with the laws, regulations and agreements that apply to my organization and to the speaker " +
  "(for example voice and likeness rights, data protection and union agreements). My " +
  "organization, not Aquilla, is responsible for obtaining, documenting and honouring that " +
  "consent, including any withdrawal of it."

/** Training needs at least this much speech; RVC wobbles below it. */
export const CUSTOM_VOICE_MIN_MINUTES = 5
/** Where quality stops improving much. */
export const CUSTOM_VOICE_RECOMMENDED_MINUTES = 15
export const CUSTOM_VOICE_MAX_MINUTES = 60
/** Same per-recording cap the worker enforces (MAX_VOICE_CLIP_BYTES). */
export const CUSTOM_VOICE_MAX_CLIP_BYTES = 20 * 1024 * 1024
export const CUSTOM_VOICE_MAX_CLIPS = 40
/** Wall-clock a training run takes, for the "ready in ~N min" hint. */
export const CUSTOM_VOICE_TRAINING_MINUTES = 45

export type CustomVoiceState = "queued" | "training" | "ready" | "failed"

export interface CustomVoiceStatus {
  state: CustomVoiceState
  error?: string
  started_at?: number
}

export function isCustomVoice(voice: Pick<Voice, "libraryVoiceId" | "customVoice">): boolean {
  return voice.customVoice != null && voice.libraryVoiceId != null
}

function customBase(projectId: string): string {
  return `${syncWorkerHttpOrigin()}/api/v1/voice/custom/${encodeURIComponent(projectId)}`
}

export interface StartCustomVoiceArgs {
  projectId: string
  /** Any file in the project — only used to mint a project-valid sync token. */
  fileId: string
  speakerName: string
  recordings: File[]
  /** The maintainer ticked the consent statement. */
  consentConfirmed: boolean
  getSyncToken: SyncTokenForFile
  onProgress?: (uploaded: number, total: number) => void
}

export interface StartCustomVoiceResult {
  voiceId: string
  audioMinutes: number
  attestedAt: string
  statementVersion: string
}

/**
 * Upload the recordings to the project's reference store, then ask the worker to
 * record consent and start training. Returns as soon as training is queued.
 */
export async function startCustomVoiceTraining(args: StartCustomVoiceArgs): Promise<StartCustomVoiceResult> {
  const { projectId, fileId, speakerName, recordings, consentConfirmed, getSyncToken } = args
  if (!consentConfirmed) throw new Error("Confirm the speaker's consent before training a voice.")
  const referenceAudioIds: string[] = []
  for (const [i, file] of recordings.entries()) {
    const ext = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "webm"
    const referenceAudioId = buildVoiceReferenceId(ext)
    await uploadVoiceReference({ projectId, fileId, referenceAudioId, blob: file, getSyncToken })
    referenceAudioIds.push(referenceAudioId)
    args.onProgress?.(i + 1, recordings.length)
  }

  const token = await getSyncToken(projectId, fileId)
  if (!token) throw new Error("custom voice: no sync token")
  const res = await fetch(customBase(projectId), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      speakerName,
      referenceAudioIds,
      consent: { confirmed: true, statementVersion: CUSTOM_VOICE_CONSENT_VERSION },
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Couldn't start training (${res.status}): ${text || res.statusText}`)
  }
  return (await res.json()) as StartCustomVoiceResult
}

export async function fetchCustomVoiceStatus(args: {
  projectId: string
  fileId: string
  voiceId: string
  getSyncToken: SyncTokenForFile
}): Promise<CustomVoiceStatus> {
  const token = await args.getSyncToken(args.projectId, args.fileId)
  if (!token) throw new Error("custom voice: no sync token")
  const res = await fetch(`${customBase(args.projectId)}/${encodeURIComponent(args.voiceId)}/status`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`status ${res.status}`)
  return (await res.json()) as CustomVoiceStatus
}

/** The cast Voice for a freshly started custom voice. */
export function voiceFromCustomTraining(
  started: StartCustomVoiceResult,
  base: { id: string; name: string; color?: string; attestedByUsername: string },
): Voice {
  return {
    id: base.id,
    name: base.name,
    ...(base.color ? { color: base.color } : {}),
    libraryVoiceId: started.voiceId,
    customVoice: {
      speakerName: base.name,
      consentAttestedAt: started.attestedAt,
      consentAttestedBy: base.attestedByUsername,
      consentStatementVersion: started.statementVersion,
      trainingStartedAt: started.attestedAt,
    },
  }
}

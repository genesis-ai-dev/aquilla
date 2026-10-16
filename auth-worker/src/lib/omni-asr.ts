// Client for the self-hosted Omnilingual ASR service on Modal
// (infra/modal/omnilingual_asr.py; spec docs/superpowers/specs/2026-10-16-omnilingual-asr.md).
// Every call carries the shared secret; the service compares it in constant time.

import { z } from "zod"
import type { Env } from "../types"
import type { OmniModel } from "../../../db/shared/omni-asr-cost"

/** The service rejects input at or over 40 s; reject before reserving spend. */
export const OMNI_MAX_AUDIO_SECONDS = 40

export const omniTranscribeResponseSchema = z.object({
  text: z.string(),
  words: z.array(z.object({
    text: z.string(),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
  })),
  gpuSeconds: z.number().finite().nonnegative(),
  /** CUDA device name, e.g. "NVIDIA L4"; unknown names bill at the top rate. */
  gpu: z.string().min(1).max(100),
  timingsApproximate: z.boolean().optional(),
})

/** A cold ZS container answers this (HTTP 200) instead of blocking; no GPU ran. */
export const omniWarmingSchema = z.object({ warming: z.literal(true) })

export const omniStatusSchema = z.object({
  state: z.enum(["cold", "starting", "ready"]),
  estGpuSecPerAudioSec: z.number().finite().nonnegative().optional(),
})

export function omniConfigured(env: Env): env is Env & { OMNI_ASR_MODAL_URL: string; OMNI_SHARED_SECRET: string } {
  return Boolean(env.OMNI_ASR_MODAL_URL && env.OMNI_SHARED_SECRET)
}

function omniUrl(env: Env & { OMNI_ASR_MODAL_URL: string }, path: string) {
  return `${env.OMNI_ASR_MODAL_URL.replace(/\/+$/, "")}${path}`
}

/**
 * A cold CTC container (boot + ~25 s model load) answers in 60–90 s, so CTC
 * needs more than the Whisper path's 65 s. ZS never cold-loads here: the
 * service answers `{warming:true}` instead. Both stay under Modal's 150 s
 * web-request limit.
 */
const TRANSCRIBE_TIMEOUT_MS: Record<OmniModel, number> = { ctc: 140000, zs: 140000 }

export function omniFetch(
  env: Env & { OMNI_ASR_MODAL_URL: string; OMNI_SHARED_SECRET: string },
  path: "/transcribe" | "/warm" | `/status?${string}`,
  init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number },
) {
  return fetch(omniUrl(env, path), {
    method: init.method,
    headers: {
      "X-Omni-Secret": env.OMNI_SHARED_SECRET,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs),
  })
}

export function omniTranscribe(
  env: Env & { OMNI_ASR_MODAL_URL: string; OMNI_SHARED_SECRET: string },
  body: { model: OmniModel; audio: string; lang?: string; examples?: Array<{ url: string; text: string }> },
) {
  return omniFetch(env, "/transcribe", { method: "POST", body, timeoutMs: TRANSCRIBE_TIMEOUT_MS[body.model] })
}

/** ZS example audio must come from our own signed example-audio route on
 *  sync-worker (sync-worker/src/events/transcription-examples-route.ts), so a
 *  caller cannot make the GPU box fetch arbitrary URLs. */
export function isAllowedExampleUrl(env: Env, url: string): boolean {
  const base = env.SYNC_WORKER_URL?.replace(/\/+$/, "")
  if (!base) return false
  let parsed: URL
  let allowed: URL
  try { parsed = new URL(url); allowed = new URL(base) } catch { return false }
  return parsed.origin === allowed.origin
    && parsed.pathname === `${allowed.pathname.replace(/\/+$/, "")}/api/v1/transcription-examples/audio`
    && parsed.username === "" && parsed.password === ""
}

/** Org admins may turn zero-shot off (`org_settings.settings.transcription.
 *  zeroShotEnabled === false`). Absent means enabled. A project with no org
 *  has no admin to disable it. Throws if the setting cannot be read: the
 *  caller fails closed rather than guessing. */
export async function zeroShotEnabledForOrg(db: AquillaDb, orgId: number): Promise<boolean> {
  if (orgId <= 0) return true
  const row = await db.prepare("SELECT settings FROM org_settings WHERE org_id = ?")
    .bind(orgId).first<{ settings: string | Record<string, unknown> | null }>()
  if (!row?.settings) return true
  const settings = typeof row.settings === "string"
    ? JSON.parse(row.settings) as Record<string, unknown>
    : row.settings
  const transcription = settings.transcription
  if (!transcription || typeof transcription !== "object") return true
  return (transcription as { zeroShotEnabled?: unknown }).zeroShotEnabled !== false
}

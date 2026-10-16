// Zero-shot cold start (Omnilingual ASR spec §5). The 7B model takes 1–3
// minutes to load, so before a ZS run the client asks the server whether it is
// up, starts it if not, and polls until it is. Every ZS transcription queued at
// the same moment (a batch) waits on ONE warm-up and one toast.

import { AUTH_BASE } from "@/lib/frontier/auth"
import { t } from "@/lib/i18n/standalone"

export type ZsState = "cold" | "starting" | "ready"
export interface ZsStatus {
  state: ZsState
  /** The server's GPU-seconds per audio-second, for the batch estimate. */
  estGpuSecPerAudioSec?: number
}

export const WARMUP_POLL_MS = 4000
export const WARMUP_CAP_MS = 6 * 60 * 1000

/** What the person chose when the model did not start in time. */
export type WarmupTimeoutChoice = "retry" | "auto" | "dismiss"

/** The toast, kept apart so tests can drive the poller without the DOM. */
export interface WarmupUi {
  starting(): void
  ready(): void
  timedOut(): Promise<WarmupTimeoutChoice>
}

/** "ready", or the person asked to transcribe with the automatic model instead. */
export type WarmupOutcome = { kind: "ready"; status: ZsStatus } | { kind: "use-auto" }

export class ZsWarmupError extends Error {
  constructor() {
    super(t("settings.transcription.zeroShot.warmupFailed"))
    this.name = "ZsWarmupError"
  }
}

function headers(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }
}

export async function fetchZsStatus(jwt: string, projectId: string): Promise<ZsStatus> {
  const params = new URLSearchParams({ projectId, model: "zs" })
  const response = await fetch(`${AUTH_BASE}/api/v1/audio/transcriptions/status?${params}`, {
    headers: headers(jwt), signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Zero-shot status failed (${response.status})`)
  return await response.json() as ZsStatus
}

/**
 * Ask the server to start a ZS container. Free, and returns at once. Without a
 * project (Preferences has none) the server may refuse — the run's own warm-up
 * then covers it, so a failure here is never an error.
 */
export async function warmZeroShot(jwt: string, projectId?: string): Promise<void> {
  await fetch(`${AUTH_BASE}/api/v1/audio/transcriptions/warm`, {
    method: "POST", headers: headers(jwt),
    body: JSON.stringify({ ...(projectId ? { projectId } : {}), model: "zs" }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => undefined)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

let inflight: Promise<WarmupOutcome> | null = null

/**
 * Resolve once the ZS model is ready. A run that finds it cold fires `/warm`,
 * shows the toast and polls every 4 s for up to 6 minutes; a later run that
 * arrives meanwhile shares that same wait.
 */
export function ensureZsReady(jwt: string, projectId: string, ui: WarmupUi): Promise<WarmupOutcome> {
  inflight ??= waitForReady(jwt, projectId, ui).finally(() => { inflight = null })
  return inflight
}

async function waitForReady(jwt: string, projectId: string, ui: WarmupUi): Promise<WarmupOutcome> {
  const first = await fetchZsStatus(jwt, projectId).catch(() => null)
  if (first?.state === "ready") return { kind: "ready", status: first }
  for (;;) {
    await warmZeroShot(jwt, projectId)
    ui.starting()
    const deadline = Date.now() + WARMUP_CAP_MS
    while (Date.now() < deadline) {
      await sleep(WARMUP_POLL_MS)
      // A failed poll is a blip, not an answer: keep polling until the cap.
      const status = await fetchZsStatus(jwt, projectId).catch(() => null)
      if (status?.state === "ready") {
        ui.ready()
        return { kind: "ready", status }
      }
    }
    const choice = await ui.timedOut()
    if (choice === "auto") return { kind: "use-auto" }
    if (choice === "dismiss") throw new ZsWarmupError()
  }
}

/** @internal — test-only. */
export function __resetZsWarmupForTests(): void {
  inflight = null
}

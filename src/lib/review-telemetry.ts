/**
 * AQU-1572: send the validation and audio events from the browser.
 *
 * The properties come from `review-events.ts`; this only hands them to
 * PostHog, which is consent-gated in `posthog.ts`. Call these once per ACTION
 * the person took — after a bulk loop, not inside it — and only once the
 * write is in the outbox, so a refused or failed write never reads as done.
 *
 * Deliberately NOT reported: the validation a person's own edit adds by
 * itself (`shouldAutoValidateHumanEdit`). It fires on every saved edit, so it
 * would bury the deliberate approvals this event exists to count; the edit is
 * already visible as a commit.
 */
import posthog from "@/lib/posthog"
import {
  audioAttachedEvent,
  audioGeneratedEvent,
  audioRecordedEvent,
  validationEvent,
  type AudioAttachedInput,
  type AudioGeneratedInput,
  type AudioRecordedInput,
  type TelemetryEvent,
  type ValidationEventInput,
} from "@/lib/review-events"

/** How many events the dev log keeps; old ones fall off the front. */
const DEV_LOG_LIMIT = 200

/**
 * A dev build has no PostHog key, so `posthog.capture` goes nowhere and these
 * events could not be checked by hand at all. In dev only, keep the last few
 * on `window.__aqTelemetry` — type it in the console after a click to see
 * exactly what would have been sent.
 */
function recordForDevtools(event: TelemetryEvent): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return
  const win = window as unknown as { __aqTelemetry?: TelemetryEvent[] }
  const log = win.__aqTelemetry ?? (win.__aqTelemetry = [])
  log.push(event)
  if (log.length > DEV_LOG_LIMIT) log.splice(0, log.length - DEV_LOG_LIMIT)
}

function send(event: TelemetryEvent | null): void {
  if (!event) return
  try {
    recordForDevtools(event)
    posthog.capture(event.event, event.properties)
  } catch {
    // Telemetry never gets to break the action it describes.
  }
}

export function reportValidation(input: ValidationEventInput): void {
  send(validationEvent(input))
}

export function reportAudioAttached(input: AudioAttachedInput): void {
  send(audioAttachedEvent(input))
}

export function reportAudioRecorded(input: AudioRecordedInput): void {
  send(audioRecordedEvent(input))
}

export function reportAudioGenerated(input: AudioGeneratedInput): void {
  send(audioGeneratedEvent(input))
}

/** One generated clip, as `generateAndAttachCellVoice` describes it. */
export interface GeneratedClip {
  fileId: string
  cellId: string
  provider: string
  voiceKind: "stock" | "clone"
  voiceId?: string
  durationMs?: number | null
}

/**
 * Report the clips one action generated (a Generate-all run, a line voiced
 * onto all its heard lines) as ONE event. Provider and voice are named when
 * every clip shares them, and called "mixed" when they don't.
 */
export function reportGeneratedClips(
  clips: readonly GeneratedClip[],
  context: { projectId: string; lane?: string | null; surface?: string },
): void {
  if (clips.length === 0) return
  const only = <T,>(values: T[]): T | undefined => (new Set(values).size === 1 ? values[0] : undefined)
  const provider = only(clips.map((c) => c.provider))
  const voiceKind = only(clips.map((c) => c.voiceKind))
  const voiceId = only(clips.map((c) => c.voiceId))
  const durations = clips.map((c) => c.durationMs).filter((ms): ms is number => typeof ms === "number")
  reportAudioGenerated({
    projectId: context.projectId,
    cells: clips,
    lane: context.lane,
    source: "ui",
    ...(context.surface ? { surface: context.surface } : {}),
    provider: provider ?? "mixed",
    voiceKind: voiceKind ?? "mixed",
    voiceId: voiceKind === "stock" ? voiceId : undefined,
    durationMs: durations.length === clips.length ? durations.reduce((a, b) => a + b, 0) : undefined,
  })
}

// One monitor run: probe every target, update stored state, alert on changes,
// then ping the external heartbeat. Dependencies are injected so the whole run
// is testable without the Workers runtime.

import type { MonitorConfig } from "./config"
import { buildMessage, sendDiscord } from "./discord"
import { probe } from "./probe"
import type { AlertEvent, TargetState, Thresholds } from "./state"
import type { ProbeResult } from "./probe"

export interface TickDeps {
  fetch: typeof fetch
  now: () => number
  /** Applies results to stored state (the Durable Object) and returns alerts. */
  record(results: ProbeResult[], thresholds: Thresholds, now: number): Promise<{
    states: Record<string, TargetState>
    events: AlertEvent[]
  }>
  discordWebhookUrl?: string
  /** Optional dead-man's-switch URL (e.g. Better Stack or healthchecks.io). */
  heartbeatUrl?: string
}

export async function runTick(config: MonitorConfig, deps: TickDeps): Promise<AlertEvent[]> {
  const results = await Promise.all(config.targets.map((t) => probe(t, deps.fetch, deps.now)))
  const { failureThreshold, recoveryThreshold, reminderMinutes } = config
  const { events } = await deps.record(results, { failureThreshold, recoveryThreshold, reminderMinutes }, deps.now())

  const message = buildMessage(events, config)
  if (message) {
    if (!deps.discordWebhookUrl) {
      // Throwing marks the cron run failed in the dashboard and skips the
      // heartbeat, so the external monitor notices that alerts cannot go out.
      throw new Error(`DISCORD_WEBHOOK_URL is not set; ${events.length} alert(s) not sent`)
    }
    await sendDiscord(deps.discordWebhookUrl, message, deps.fetch)
  }

  // Last, and only when everything above worked: a missed heartbeat then means
  // "the monitor is broken or cannot alert", which is what it must catch.
  if (deps.heartbeatUrl) {
    await deps.fetch(deps.heartbeatUrl, { method: "GET", signal: AbortSignal.timeout(10_000) })
      .then((r) => r.body?.cancel())
      .catch((error: unknown) => console.error("[monitor] heartbeat failed", error instanceof Error ? error.message : error))
  }
  return events
}

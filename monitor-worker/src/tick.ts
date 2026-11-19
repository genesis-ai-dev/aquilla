// One monitor run: probe every target, update stored state, alert on changes,
// then ping the external heartbeat. Dependencies are injected so the whole run
// is testable without the Workers runtime.

import type { MonitorConfig } from "./config"
import { buildMessage, buildStuckSessionsMessage, sendDiscord } from "./discord"
import { probe } from "./probe"
import type { AlertEvent, TargetState, Thresholds } from "./state"
import type { ProbeResult } from "./probe"
import {
  probeStuckSessions,
  type StuckSessionsAlert,
  type StuckSessionsReading,
  type StuckSessionsState,
} from "./stuck-sessions"

export interface TickDeps {
  fetch: typeof fetch
  now: () => number
  /** Applies results to stored state (the Durable Object) and returns alerts. */
  record(results: ProbeResult[], thresholds: Thresholds, now: number): Promise<{
    states: Record<string, TargetState>
    events: AlertEvent[]
  }>
  /** Applies one stuck-session reading to stored state (AQU-2611). */
  recordStuckSessions(reading: StuckSessionsReading, now: number): Promise<{
    state: StuckSessionsState
    alert?: StuckSessionsAlert
  }>
  /** Admin bearer for the stuck-session probe. Kept out of MonitorConfig so the
   *  secret never reaches the object /status serializes. */
  syncAdminToken?: string
  discordWebhookUrl?: string
  /** Optional dead-man's-switch URL (e.g. Better Stack or healthchecks.io). */
  heartbeatUrl?: string
}

export interface TickOutcome {
  events: AlertEvent[]
  stuckSessions?: StuckSessionsAlert
}

export async function runTick(config: MonitorConfig, deps: TickDeps): Promise<TickOutcome> {
  // A probe URL with no bearer is a half-finished rollout. It is raised at the
  // end of the run, not here: the uptime alerts still have to go out, and this
  // must not be reported as a healthy database either.
  const missingToken = Boolean(config.stuckSessions) && !deps.syncAdminToken
  // Both checks probe in parallel: the database check must not be delayed by a
  // target that is timing out, since it is the one with a 10-minute repeat.
  const [results, stuckReading] = await Promise.all([
    Promise.all(config.targets.map((t) => probe(t, deps.fetch, deps.now))),
    config.stuckSessions && deps.syncAdminToken
      ? probeStuckSessions(config.stuckSessions, deps.syncAdminToken, deps.fetch)
      : Promise.resolve(undefined),
  ])
  const { failureThreshold, recoveryThreshold, reminderMinutes } = config
  const { events } = await deps.record(results, { failureThreshold, recoveryThreshold, reminderMinutes }, deps.now())
  const stuck = stuckReading
    ? await deps.recordStuckSessions(stuckReading, deps.now())
    : undefined

  const message = buildMessage(events, config)
  if (message) {
    if (!deps.discordWebhookUrl) {
      // Throwing marks the cron run failed in the dashboard and skips the
      // heartbeat, so the external monitor notices that alerts cannot go out.
      throw new Error(`DISCORD_WEBHOOK_URL is not set; ${events.length} alert(s) not sent`)
    }
    await sendDiscord(deps.discordWebhookUrl, message, deps.fetch)
  }

  if (stuck?.alert) {
    const stuckMessage = buildStuckSessionsMessage(stuck.alert, config)
    if (stuckMessage) {
      if (!deps.discordWebhookUrl) {
        throw new Error("DISCORD_WEBHOOK_URL is not set; stuck-session alert not sent")
      }
      await sendDiscord(deps.discordWebhookUrl, stuckMessage, deps.fetch)
    }
  }

  // A check that cannot run is a broken check, not a healthy database: fail the
  // run so the dashboard shows it and the heartbeat is skipped, which is what
  // makes the external dead-man's switch notice.
  if (missingToken) {
    throw new Error("STUCK_SESSIONS_URL is set but SYNC_ADMIN_TOKEN is not; the check did not run")
  }
  if (stuckReading && !stuckReading.ok) {
    throw new Error(`stuck-session probe failed: ${stuckReading.error ?? "unknown error"}`)
  }

  // Last, and only when everything above worked: a missed heartbeat then means
  // "the monitor is broken or cannot alert", which is what it must catch.
  if (deps.heartbeatUrl) {
    await deps.fetch(deps.heartbeatUrl, { method: "GET", signal: AbortSignal.timeout(10_000) })
      .then((r) => r.body?.cancel())
      .catch((error: unknown) => console.error("[monitor] heartbeat failed", error instanceof Error ? error.message : error))
  }
  return { events, stuckSessions: stuck?.alert }
}

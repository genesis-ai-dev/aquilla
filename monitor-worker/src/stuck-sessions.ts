// AQU-2611 — the "database sessions are stuck half-sent" check.
//
// This is not an uptime check, so it does not go through MONITOR_TARGETS. An
// HTTP target is up or down; this one reads a *number* off the database and
// alerts above a threshold. On 2026-11-13 and 2026-11-16 production ran out of
// Hyperdrive origin connections with up to 55 of 60 sessions `active` in
// `ClientRead` for ten minutes — and every uptime target stayed green, because
// a fresh `SELECT 1` succeeds right until the origin has no connection left.
// The leak is only visible from the server's side of the socket.
//
// The count comes from sync-worker's `GET /admin/db/stuck-sessions` (that
// Worker already holds the Hyperdrive binding; this one deliberately carries no
// database driver). The probe reports the stuck statement's leading text, which
// is what names the leaking route.
//
// Alerting differs from the uptime state machine in two ways that matter:
//   - no failureThreshold ramp. The threshold IS the signal: a healthy database
//     has zero such sessions, so 5 of them is already the outage, and waiting
//     three more minutes to say so wastes the warning.
//   - its own repeat interval (10 min, not REMINDER_MINUTES' 60): this one is
//     actionable while it holds and goes away on its own if the fix works.

import type { DiscordEmbed } from "./discord"

export interface StuckSessionsConfig {
  /** sync-worker's probe, e.g. https://api.aquilla.app/sync/admin/db/stuck-sessions */
  url: string
  /** Alert once this many sessions are stuck. */
  threshold: number
  /** While the condition holds, alert again at most this often. 0 = never repeat. */
  repeatMinutes: number
  timeoutMs: number
}

/** One reading of the probe. `ok` is whether the probe *answered*, not whether
 *  the database is healthy — a probe that cannot be read is reported as a
 *  failed monitor run (the heartbeat catches it), never as "zero stuck". */
export interface StuckSessionsReading {
  ok: boolean
  count: number
  /** Same predicate without the application_name filter — see the route. */
  countAnyApplication?: number
  sampleQuery?: string
  error?: string
}

export interface StuckSessionsState {
  /** True while the count has been at or above the threshold. */
  alerting: boolean
  /** When the condition was first observed. */
  since?: number
  /** Last time an alert for this episode went out. */
  lastAlertAt?: number
  /** Highest count seen during this episode. */
  peakCount?: number
  lastCount: number
  lastCheckedAt: number
}

export type StuckSessionsAlertKind = "stuck" | "cleared"

export interface StuckSessionsAlert {
  kind: StuckSessionsAlertKind
  at: number
  /** When the episode began. */
  since: number
  count: number
  peakCount: number
  sampleQuery?: string
  /** True when this is a repeat of an alert already sent for this episode. */
  repeat: boolean
}

export const DEFAULT_THRESHOLD = 5
export const DEFAULT_REPEAT_MINUTES = 10
export const DEFAULT_TIMEOUT_MS = 10_000

export function initialStuckSessionsState(now: number): StuckSessionsState {
  return { alerting: false, lastCount: 0, lastCheckedAt: now }
}

/** The whole alert decision, pure so the threshold and the throttle are tested
 *  without a database, a Durable Object or a clock. */
export function evaluateStuckSessions(
  prev: StuckSessionsState,
  reading: StuckSessionsReading,
  config: Pick<StuckSessionsConfig, "threshold" | "repeatMinutes">,
  now: number,
): { next: StuckSessionsState; alert?: StuckSessionsAlert } {
  // A probe that did not answer tells us nothing. Hold the previous state
  // rather than reading it as a recovery, which would post a false "cleared".
  if (!reading.ok) return { next: { ...prev, lastCheckedAt: now } }

  const count = reading.count
  const over = count >= config.threshold

  if (!over) {
    const next: StuckSessionsState = {
      alerting: false,
      lastCount: count,
      lastCheckedAt: now,
    }
    if (!prev.alerting) return { next }
    return {
      next,
      alert: {
        kind: "cleared",
        at: now,
        since: prev.since ?? now,
        count,
        peakCount: Math.max(prev.peakCount ?? 0, prev.lastCount),
        repeat: false,
      },
    }
  }

  const since = prev.alerting ? (prev.since ?? now) : now
  const peakCount = prev.alerting ? Math.max(prev.peakCount ?? 0, count) : count
  const base: StuckSessionsState = { alerting: true, since, peakCount, lastCount: count, lastCheckedAt: now }

  const repeatMs = config.repeatMinutes * 60_000
  const dueForRepeat =
    prev.alerting && repeatMs > 0 && now - (prev.lastAlertAt ?? since) >= repeatMs
  if (prev.alerting && !dueForRepeat) {
    // Inside the throttle window: keep watching, say nothing.
    return { next: { ...base, lastAlertAt: prev.lastAlertAt } }
  }

  return {
    next: { ...base, lastAlertAt: now },
    alert: {
      kind: "stuck",
      at: now,
      since,
      count,
      peakCount,
      sampleQuery: reading.sampleQuery,
      repeat: prev.alerting,
    },
  }
}

interface StuckSessionsProbeBody {
  n?: unknown
  backendsAnyApplication?: unknown
  sampleQuery?: unknown
}

const asCount = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined
}

/** Reads the count off sync-worker's admin probe. The bearer is passed in
 *  rather than held in config so the secret never travels in the object the
 *  `/status` route can serialize. */
export async function probeStuckSessions(
  config: StuckSessionsConfig,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StuckSessionsReading> {
  try {
    const response = await fetchImpl(config.url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "aquilla-monitor/1",
        "Cache-Control": "no-cache",
      },
    })
    if (response.status !== 200) {
      await response.body?.cancel()
      return { ok: false, count: 0, error: `probe answered HTTP ${response.status}` }
    }
    const body = (await response.json()) as StuckSessionsProbeBody
    const count = asCount(body.n)
    if (count === undefined) return { ok: false, count: 0, error: "probe answered without a count" }
    return {
      ok: true,
      count,
      countAnyApplication: asCount(body.backendsAnyApplication),
      sampleQuery: typeof body.sampleQuery === "string" ? body.sampleQuery : undefined,
    }
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    const message = timedOut
      ? `no response in ${Math.round(config.timeoutMs / 1000)}s`
      : error instanceof Error ? error.message : String(error)
    return { ok: false, count: 0, error: message.slice(0, 200) }
  }
}

const RED = 0xe5484d
const ORANGE = 0xf76b15
const GREEN = 0x30a46c

/** Keeps the statement text inert: no mentions, no markdown that breaks the
 *  field. postgres.js sends parameterized SQL, so this is the statement
 *  template ($1, $2, …) rather than row values. */
function quote(text: string): string {
  return "```sql\n" + text.replace(/`/g, "'").slice(0, 300) + "\n```"
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 1) return "less than 1 min"
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

export function stuckSessionsEmbed(
  alert: StuckSessionsAlert,
  config: StuckSessionsConfig,
): DiscordEmbed {
  const fields: DiscordEmbed["fields"] = []
  if (alert.kind === "cleared") {
    fields.push({ name: "Stuck for", value: formatDuration(alert.at - alert.since), inline: true })
    fields.push({ name: "Peak sessions", value: String(alert.peakCount), inline: true })
  } else {
    fields.push({ name: "Stuck sessions", value: String(alert.count), inline: true })
    fields.push({ name: "Threshold", value: `≥ ${config.threshold}`, inline: true })
    fields.push({ name: "Since", value: `<t:${Math.floor(alert.since / 1000)}:R>`, inline: true })
    // The statement text is the point of the alert: it names the leaking route.
    if (alert.sampleQuery) fields.push({ name: "Stuck statement", value: quote(alert.sampleQuery) })
  }

  const title = alert.kind === "cleared"
    ? "🟢 Database sessions are no longer stuck"
    : alert.repeat
      ? `🟠 ${alert.count} database sessions STILL stuck half-sent (${formatDuration(alert.at - alert.since)})`
      : `🔴 ${alert.count} database sessions stuck half-sent (active / ClientRead)`
  const color = alert.kind === "cleared" ? GREEN : alert.repeat ? ORANGE : RED

  return {
    title,
    description: alert.kind === "cleared"
      ? undefined
      : "Origin connections are being held open mid-statement. Hyperdrive will run out — see AQU-2611.",
    color,
    fields,
    timestamp: new Date(alert.at).toISOString(),
  }
}

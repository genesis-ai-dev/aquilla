// Reads the monitor's settings from Worker vars and secrets. Every value has a
// safe default except the target list, so a bad var fails the tick loudly
// (Workers Logs) instead of silently monitoring nothing.

import {
  DEFAULT_REPEAT_MINUTES,
  DEFAULT_THRESHOLD,
  DEFAULT_TIMEOUT_MS,
  type StuckSessionsConfig,
} from "./stuck-sessions"

export interface Target {
  /** Stable key for stored state. Renaming it resets that target's history. */
  id: string
  /** Shown in Discord. */
  name: string
  url: string
  /** HTTP status that counts as healthy. Default 200. */
  expectStatus?: number
  /** Text the body must contain, e.g. `"ok":true`. Catches a 200 error page. */
  expectBodyIncludes?: string
  /** Default 10 s. */
  timeoutMs?: number
}

export interface MonitorConfig {
  environment: string
  targets: Target[]
  /** The AQU-2611 database check, or null when it is not configured. */
  stuckSessions: StuckSessionsConfig | null
  /** Consecutive failed checks before a target is marked down. */
  failureThreshold: number
  /** Consecutive good checks before a down target is marked up again. */
  recoveryThreshold: number
  /** While a target stays down, mention the team again this often. 0 = never. */
  reminderMinutes: number
  mentionRoleIds: string[]
  mentionUserIds: string[]
}

export interface MonitorEnv {
  ENVIRONMENT_LABEL?: string
  /** sync-worker's stuck-session probe URL. Unset disables the check. */
  STUCK_SESSIONS_URL?: string
  /** Sessions stuck half-sent before alerting. Default 5. */
  STUCK_SESSIONS_THRESHOLD?: string
  /** Minutes between repeat alerts while stuck. Default 10. 0 = never repeat. */
  STUCK_SESSIONS_REPEAT_MINUTES?: string
  /** Admin bearer for the probe (a secret). Required once STUCK_SESSIONS_URL is
   *  set, but deliberately NOT read here: it never belongs in MonitorConfig,
   *  which /status serializes. runTick enforces the pairing — see below. */
  /** JSON array of Target. */
  MONITOR_TARGETS?: string
  FAILURE_THRESHOLD?: string
  RECOVERY_THRESHOLD?: string
  REMINDER_MINUTES?: string
  /** Comma-separated Discord role ids to mention on an outage. */
  DISCORD_MENTION_ROLE_IDS?: string
  /** Comma-separated Discord user ids to mention on an outage. */
  DISCORD_MENTION_USER_IDS?: string
}

/** Discord snowflakes are 17–20 digit integers. Anything else would either do
 *  nothing or, worse, let a typo in a var inject `@everyone` text. */
const SNOWFLAKE = /^\d{17,20}$/

function parseIds(raw: string | undefined, label: string): string[] {
  const ids = (raw ?? "").split(",").map((id) => id.trim()).filter(Boolean)
  for (const id of ids) {
    if (!SNOWFLAKE.test(id)) throw new Error(`${label} contains "${id}", which is not a Discord id`)
  }
  return ids
}

function parseCount(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === "") return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) throw new Error(`expected an integer >= ${min}, got "${raw}"`)
  return value
}

function parseTargets(raw: string | undefined): Target[] {
  if (!raw) throw new Error("MONITOR_TARGETS is not set")
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("MONITOR_TARGETS must be a non-empty JSON array")
  const seen = new Set<string>()
  return parsed.map((entry: unknown, index) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`MONITOR_TARGETS[${index}] is not an object`)
    const t = entry as Record<string, unknown>
    if (typeof t.id !== "string" || !t.id) throw new Error(`MONITOR_TARGETS[${index}].id is missing`)
    if (typeof t.name !== "string" || !t.name) throw new Error(`MONITOR_TARGETS[${index}].name is missing`)
    if (typeof t.url !== "string" || !/^https?:\/\//.test(t.url)) throw new Error(`MONITOR_TARGETS[${index}].url is not an http(s) URL`)
    if (seen.has(t.id)) throw new Error(`MONITOR_TARGETS has two targets with id "${t.id}"`)
    seen.add(t.id)
    return {
      id: t.id,
      name: t.name,
      url: t.url,
      expectStatus: typeof t.expectStatus === "number" ? t.expectStatus : undefined,
      expectBodyIncludes: typeof t.expectBodyIncludes === "string" ? t.expectBodyIncludes : undefined,
      timeoutMs: typeof t.timeoutMs === "number" ? t.timeoutMs : undefined,
    }
  })
}

/** The AQU-2611 check is off unless a probe URL is set. The missing-token case
 *  is runTick's to raise, not this function's: readConfig runs before any
 *  probing, so throwing here would take the uptime checks down with it while a
 *  secret is being provisioned. */
function parseStuckSessions(env: MonitorEnv): StuckSessionsConfig | null {
  const url = env.STUCK_SESSIONS_URL?.trim()
  if (!url) return null
  if (!/^https?:\/\//.test(url)) throw new Error("STUCK_SESSIONS_URL is not an http(s) URL")
  return {
    url,
    threshold: parseCount(env.STUCK_SESSIONS_THRESHOLD, DEFAULT_THRESHOLD, 1),
    repeatMinutes: parseCount(env.STUCK_SESSIONS_REPEAT_MINUTES, DEFAULT_REPEAT_MINUTES, 0),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }
}

export function readConfig(env: MonitorEnv): MonitorConfig {
  return {
    environment: env.ENVIRONMENT_LABEL?.trim() || "local",
    targets: parseTargets(env.MONITOR_TARGETS),
    stuckSessions: parseStuckSessions(env),
    failureThreshold: parseCount(env.FAILURE_THRESHOLD, 3, 1),
    recoveryThreshold: parseCount(env.RECOVERY_THRESHOLD, 2, 1),
    reminderMinutes: parseCount(env.REMINDER_MINUTES, 60, 0),
    mentionRoleIds: parseIds(env.DISCORD_MENTION_ROLE_IDS, "DISCORD_MENTION_ROLE_IDS"),
    mentionUserIds: parseIds(env.DISCORD_MENTION_USER_IDS, "DISCORD_MENTION_USER_IDS"),
  }
}

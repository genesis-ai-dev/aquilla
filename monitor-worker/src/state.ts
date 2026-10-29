// The up/down state machine. Pure, so every alert decision is unit-tested; the
// Durable Object only stores what this returns.
//
// Rules:
//   - A target is "down" after `failureThreshold` failed checks in a row, and
//     "up" again after `recoveryThreshold` good checks in a row. One blip in
//     either direction changes nothing, so the team is not paged for noise.
//   - An alert fires on a change of state, never on each failed check.
//   - While a target stays down, a reminder fires every `reminderMinutes`.
//   - A new target starts "unknown" and turns "up" silently on its first good
//     check. If it is failing from the start it goes down with an alert.

import type { ProbeResult } from "./probe"

export type TargetStatus = "unknown" | "up" | "down"

export interface TargetState {
  status: TargetStatus
  /** Failed checks in a row (0 after a good one). */
  failures: number
  /** Good checks in a row (0 after a failed one). */
  successes: number
  /** When the current run of failures began. Survives into "down". */
  firstFailureAt?: number
  /** When the current status began. */
  since: number
  /** Last time the team was mentioned for this target. */
  lastAlertAt?: number
  lastCheckedAt: number
  lastLatencyMs?: number
  lastHttpStatus?: number
  lastError?: string
}

export type AlertKind = "down" | "reminder" | "recovered"

export interface AlertEvent {
  kind: AlertKind
  targetId: string
  at: number
  /** For "down"/"reminder": when the failures began. For "recovered": when the outage began. */
  downSince: number
  error?: string
  httpStatus?: number
  latencyMs: number
}

export interface Thresholds {
  failureThreshold: number
  recoveryThreshold: number
  reminderMinutes: number
}

export function initialState(now: number): TargetState {
  return { status: "unknown", failures: 0, successes: 0, since: now, lastCheckedAt: now }
}

export function evaluate(
  prev: TargetState,
  result: ProbeResult,
  thresholds: Thresholds,
  now: number,
): { next: TargetState; event?: AlertEvent } {
  const observed = {
    lastCheckedAt: now,
    lastLatencyMs: result.latencyMs,
    lastHttpStatus: result.status,
    lastError: result.ok ? prev.lastError : result.error,
  }

  if (result.ok) {
    const successes = prev.successes + 1
    const base: TargetState = { ...prev, ...observed, failures: 0, successes, firstFailureAt: undefined }
    if (prev.status === "down" && successes >= thresholds.recoveryThreshold) {
      return {
        next: { ...base, status: "up", since: now, lastAlertAt: undefined },
        event: {
          kind: "recovered",
          targetId: result.id,
          at: now,
          downSince: prev.firstFailureAt ?? prev.since,
          httpStatus: result.status,
          latencyMs: result.latencyMs,
        },
      }
    }
    if (prev.status === "unknown") return { next: { ...base, status: "up", since: now } }
    // Still down while recovery is pending: keep the outage start for the
    // "recovered" message.
    return { next: { ...base, firstFailureAt: prev.status === "down" ? prev.firstFailureAt : undefined } }
  }

  const failures = prev.failures + 1
  const firstFailureAt = prev.failures === 0 && prev.status !== "down" ? now : (prev.firstFailureAt ?? now)
  const base: TargetState = { ...prev, ...observed, failures, successes: 0, firstFailureAt }
  const failedEvent = (kind: AlertKind): AlertEvent => ({
    kind,
    targetId: result.id,
    at: now,
    downSince: firstFailureAt,
    error: result.error,
    httpStatus: result.status,
    latencyMs: result.latencyMs,
  })

  if (prev.status !== "down") {
    if (failures < thresholds.failureThreshold) return { next: base }
    return { next: { ...base, status: "down", since: now, lastAlertAt: now }, event: failedEvent("down") }
  }

  const reminderMs = thresholds.reminderMinutes * 60_000
  if (reminderMs > 0 && now - (prev.lastAlertAt ?? prev.since) >= reminderMs) {
    return { next: { ...base, lastAlertAt: now }, event: failedEvent("reminder") }
  }
  return { next: base }
}

/** Applies one tick of results to every stored target. Targets missing from
 *  `results` (removed from MONITOR_TARGETS) are dropped from state. */
export function applyResults(
  stored: Record<string, TargetState>,
  results: ProbeResult[],
  thresholds: Thresholds,
  now: number,
): { states: Record<string, TargetState>; events: AlertEvent[] } {
  const states: Record<string, TargetState> = {}
  const events: AlertEvent[] = []
  for (const result of results) {
    const { next, event } = evaluate(stored[result.id] ?? initialState(now), result, thresholds, now)
    states[result.id] = next
    if (event) events.push(event)
  }
  return { states, events }
}

// Singleton Durable Object that holds every target's up/down state. A DO
// (not KV) because each tick reads then writes the same record, and KV's
// eventual consistency could replay a stale state and send an alert twice.

import { DurableObject } from "cloudflare:workers"
import type { ProbeResult } from "./probe"
import { applyResults, type TargetState, type Thresholds } from "./state"
import {
  evaluateStuckSessions,
  initialStuckSessionsState,
  type StuckSessionsConfig,
  type StuckSessionsReading,
  type StuckSessionsState,
} from "./stuck-sessions"

const STATE_KEY = "targets"
/** AQU-2611 state lives beside the targets, under its own key: it is one
 *  record, not a per-target one, and it must survive a MONITOR_TARGETS edit. */
const STUCK_SESSIONS_KEY = "stuckSessions"

export class MonitorState extends DurableObject {
  async record(results: ProbeResult[], thresholds: Thresholds, now: number) {
    const stored = (await this.ctx.storage.get<Record<string, TargetState>>(STATE_KEY)) ?? {}
    const outcome = applyResults(stored, results, thresholds, now)
    await this.ctx.storage.put(STATE_KEY, outcome.states)
    return outcome
  }

  /** Applies one stuck-session reading (AQU-2611). The throttle lives in
   *  evaluateStuckSessions; this only persists what it decides. */
  async recordStuckSessions(
    reading: StuckSessionsReading,
    config: Pick<StuckSessionsConfig, "threshold" | "repeatMinutes">,
    now: number,
  ) {
    const stored =
      (await this.ctx.storage.get<StuckSessionsState>(STUCK_SESSIONS_KEY)) ??
      initialStuckSessionsState(now)
    const { next, alert } = evaluateStuckSessions(stored, reading, config, now)
    await this.ctx.storage.put(STUCK_SESSIONS_KEY, next)
    return { state: next, alert }
  }

  async snapshot(): Promise<Record<string, TargetState>> {
    return (await this.ctx.storage.get<Record<string, TargetState>>(STATE_KEY)) ?? {}
  }

  async stuckSessionsSnapshot(): Promise<StuckSessionsState | null> {
    return (await this.ctx.storage.get<StuckSessionsState>(STUCK_SESSIONS_KEY)) ?? null
  }
}

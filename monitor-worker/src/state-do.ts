// Singleton Durable Object that holds every target's up/down state. A DO
// (not KV) because each tick reads then writes the same record, and KV's
// eventual consistency could replay a stale state and send an alert twice.

import { DurableObject } from "cloudflare:workers"
import type { ProbeResult } from "./probe"
import { applyResults, type TargetState, type Thresholds } from "./state"

const STATE_KEY = "targets"

export class MonitorState extends DurableObject {
  async record(results: ProbeResult[], thresholds: Thresholds, now: number) {
    const stored = (await this.ctx.storage.get<Record<string, TargetState>>(STATE_KEY)) ?? {}
    const outcome = applyResults(stored, results, thresholds, now)
    await this.ctx.storage.put(STATE_KEY, outcome.states)
    return outcome
  }

  async snapshot(): Promise<Record<string, TargetState>> {
    return (await this.ctx.storage.get<Record<string, TargetState>>(STATE_KEY)) ?? {}
  }
}

/**
 * team-run-status.ts — plain-language status wording for an autopilot run,
 * shared by the Team tab's channel message and its thread header so the same
 * run never reads as two different states in the two places it appears.
 */

import type { TFunction } from "@/lib/i18n/I18nProvider"
import type { ContextualRunRecord } from "@/lib/contextual/transport"

export function runStatusKey(run: ContextualRunRecord): Parameters<TFunction>[0] {
  if (run.status === "failed") return "autopilot.status.needsAttention"
  if (run.status === "running" || run.status === "pausing") return "autopilot.status.working"
  if (run.status === "paused") return "autopilot.status.paused"
  if (run.status === "parked") {
    return run.total > run.done + run.failed ? "autopilot.status.queued" : "autopilot.status.idle"
  }
  if (run.status === "done") return "autopilot.status.complete"
  if (run.status === "terminated") return "autopilot.status.stopped"
  return "autopilot.status.notStarted"
}

export function isRunWorking(run: ContextualRunRecord): boolean {
  return run.status === "running" || run.status === "pausing"
}

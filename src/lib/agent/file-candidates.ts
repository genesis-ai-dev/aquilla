import type { FileCandidate } from "./protocol"
import type { AgentRunUi } from "./run-state"

/**
 * The file candidates to offer as buttons, de-duplicated by id. Only the run's
 * last tool step counts: if the agent moved past the "which file?" failure on
 * its own (a later step ran), the question is settled and nothing is offered.
 */
export function latestFileCandidates(run: AgentRunUi): FileCandidate[] {
  for (let i = run.items.length - 1; i >= 0; i--) {
    const item = run.items[i]
    if (item.kind !== "tool") continue
    const candidates = item.ok === false ? item.data?.candidates : undefined
    if (!candidates || candidates.length === 0) return []
    const seen = new Set<string>()
    return candidates.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
  }
  return []
}

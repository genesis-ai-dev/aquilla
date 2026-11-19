// The leader worker's few warnings that matter in the field (a long wait on
// another leader, a stolen lock, a failed boot), relayed to the page console.
// WKWebView shows a worker's console only in a separate Safari Web Inspector
// target, and leader-log-bridge.ts forwards everything only in dev builds, so
// in a shipped build these were otherwise invisible.

const CHANNEL = "aquilla-offline-leader-warnings"

export interface LeaderWarning {
  level: "warn" | "error"
  text: string
}

/** One line for a detail the page can't receive as-is (an Error doesn't survive every structured clone). */
function describeDetail(detail: unknown): string {
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`
  if (typeof detail === "string") return detail
  try {
    return JSON.stringify(detail) ?? String(detail)
  } catch {
    return String(detail)
  }
}

/**
 * Worker side: log `text` here and on the page. `details` (an error, say) are
 * folded into the page's copy as text, since the worker's own console is out
 * of reach in a shipped build.
 */
export function warnLeader(level: LeaderWarning["level"], text: string, ...details: unknown[]): void {
  console[level](text, ...details)
  if (typeof BroadcastChannel === "undefined") return
  try {
    const relayed = details.length === 0 ? text : `${text}: ${details.map(describeDetail).join(" ")}`
    const channel = new BroadcastChannel(CHANNEL)
    channel.postMessage({ level, text: relayed } satisfies LeaderWarning)
    channel.close()
  } catch {
    // Diagnostics must never break the leader.
  }
}

let listening = false

/** Page side: idempotent, the adapter is created again on a retry. */
export function listenForLeaderWarnings(): void {
  if (listening || typeof BroadcastChannel === "undefined") return
  listening = true
  new BroadcastChannel(CHANNEL).addEventListener("message", (event: MessageEvent<LeaderWarning>) => {
    const { level, text } = event.data
    console[level === "error" ? "error" : "warn"](`[leader] ${text}`)
  })
}

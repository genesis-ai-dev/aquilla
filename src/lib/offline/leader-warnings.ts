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

/** Worker side: log `text` here and on the page. */
export function warnLeader(level: LeaderWarning["level"], text: string, ...details: unknown[]): void {
  console[level](text, ...details)
  if (typeof BroadcastChannel === "undefined") return
  try {
    const channel = new BroadcastChannel(CHANNEL)
    channel.postMessage({ level, text } satisfies LeaderWarning)
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

// The warmer's manners (decision 2026-08-05): no user control — the sweep
// ADAPTS instead. It never spends a metered byte, stands down while a
// constrained link is busy keeping up, and always yields to live playback.
// One question, asked before every warm fetch: "may I start the next fetch,
// and with how many hands?"
//
// Read FRESH per call — connections change mid-sweep, and property reads are
// cheap. The Network Information API is absent from the TS DOM lib and absent
// at runtime in Safari/Firefox: undefined must mean "warm normally".

import { getQueueState } from "./play-queue"

export type WarmGate =
  | { kind: "stop"; reason: "metered" | "slow" } // give up the sweep
  | { kind: "wait" } // park, re-ask shortly
  | { kind: "go"; maxWorkers: number } // proceed, possibly narrower

interface NetworkInformationLike {
  saveData?: boolean
  effectiveType?: string
}

function connection(): NetworkInformationLike | null {
  try {
    return (navigator as Navigator & { connection?: NetworkInformationLike }).connection ?? null
  } catch {
    return null
  }
}

/**
 * The policy matrix, connection checks before playback checks:
 * - `saveData` (metered)            → stop — never speculate on a paid link.
 * - effectiveType slow-2g/2g       → stop — warming can't finish and competes
 *                                    with everything; the workspace effect
 *                                    re-arms naturally on the next lens entry.
 * - queue "loading"                → wait — live playback is actively starving
 *                                    for bytes (includes the free-timing
 *                                    readiness gate). Playback always wins.
 * - queue "playing" OR 3g          → one worker — "playing" may be invisible
 *                                    element streaming (indistinguishable from
 *                                    cache playback), so bound the competition;
 *                                    3g is usable but constrained.
 * - 4g / API absent / error        → full speed. Unknown = normal.
 */
export function warmGate(): WarmGate {
  const conn = connection()
  if (conn?.saveData === true) return { kind: "stop", reason: "metered" }
  const et = conn?.effectiveType
  if (et === "slow-2g" || et === "2g") return { kind: "stop", reason: "slow" }
  const queue = getQueueState()
  if (queue.kind === "loading") return { kind: "wait" }
  if (queue.kind === "playing" || et === "3g") return { kind: "go", maxWorkers: 1 }
  return { kind: "go", maxWorkers: Number.POSITIVE_INFINITY }
}

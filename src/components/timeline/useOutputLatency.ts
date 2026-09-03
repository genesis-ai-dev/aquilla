// React's view of the output-latency store. (AQU-646)
//
// Split from lib/audio/output-latency so that module stays free of React and
// can be unit-tested without a renderer — the same split video-clock.ts uses
// for the same reason.

import { useSyncExternalStore } from "react"
import { getOutputLatencySec, subscribeOutputLatency } from "@/lib/audio/output-latency"

/** Seconds the speaker lags the clock, or 0 when unknown — and 0 means "do not
 *  compensate", which is what every environment without a working AudioContext
 *  (the whole unit suite included) reports. */
export function useOutputLatency(): number {
  return useSyncExternalStore(subscribeOutputLatency, getOutputLatencySec, () => 0)
}

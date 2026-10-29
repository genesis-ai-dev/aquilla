// What the offline store's leader is doing while it boots, for the UI.
//
// After an update that changes the offline tables, the leader rebuilds the
// state db by replaying the whole eventlog before it hands out a store —
// minutes on a 30k-cell project, during which offline reads and writes wait.
// LiveStore reports that replay as `rehydrating` boot statuses, one per
// event; getOfflineStore() feeds them in here so OfflineLeaderWatchdog can
// show progress instead of a "restart the app?" prompt that would throw the
// rebuild away.
//
// Read by polling (the watchdog already ticks), so there are no listeners to
// notify thousands of times a second.
import type { BootStatus } from "@livestore/livestore"

export interface OfflineBootProgress {
  /** The leader is replaying the eventlog into a fresh state db. */
  rebuilding: boolean
  done: number
  total: number
  /** Date.now() of the last boot status of any kind; 0 before the first. */
  lastProgressAt: number
}

const idle: OfflineBootProgress = { rebuilding: false, done: 0, total: 0, lastProgressAt: 0 }

let progress: OfflineBootProgress = idle

export function reportOfflineBootStatus(status: BootStatus, now: () => number = Date.now): void {
  const at = now()
  if (status.stage === "rehydrating" && status.progress.total > 0) {
    progress = { rebuilding: true, done: status.progress.done, total: status.progress.total, lastProgressAt: at }
    return
  }
  progress = { ...progress, rebuilding: status.stage === "done" ? false : progress.rebuilding, lastProgressAt: at }
}

export function getOfflineBootProgress(): OfflineBootProgress {
  return progress
}

/** Test-only reset. */
export function __resetOfflineBootProgressForTests(): void {
  progress = idle
}

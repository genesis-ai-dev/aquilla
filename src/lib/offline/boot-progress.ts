// How far the offline store's leader is through rebuilding its state db.
//
// After an update that changes the offline tables, the leader replays the
// whole eventlog into a fresh state db before it hands out a store — minutes
// on a 30k-cell project, during which offline reads and writes wait.
// LiveStore reports that replay as `rehydrating` boot statuses, but its web
// adapter only serves them to the page once the leader has finished booting
// — i.e. after the replay — so they arrive in one burst at the end. Our
// @livestore/common patch also calls `globalThis.__livestoreRehydrateProgress`
// per replayed event, counting payload characters rather than events (a
// batched download event carries up to 500 cells and takes seconds, so an
// event count sat at 87% for minutes on a real store). The leader worker
// (livestore.worker.ts) installs that hook and forwards a throttled copy over
// a BroadcastChannel to the page, where OfflineLeaderWatchdog shows it
// instead of a "restart the app?" prompt that would throw the rebuild away.
//
// The page reads it by polling (the watchdog already ticks), so there are no
// listeners to notify.

const CHANNEL_NAME = "aquilla-offline-rebuild-progress"
// The hook fires once per event, thousands of times a second.
const FORWARD_EVERY_MS = 250

export interface RebuildProgressMessage {
  done: number
  total: number
}

export interface OfflineBootProgress {
  /** The leader is replaying the eventlog into a fresh state db. */
  rebuilding: boolean
  done: number
  total: number
  /** Date.now() when the current rebuild's first progress arrived; 0 when not rebuilding. */
  startedAt: number
  /** Date.now() when the last progress arrived; 0 before any. */
  lastProgressAt: number
}

const idle: OfflineBootProgress = { rebuilding: false, done: 0, total: 0, startedAt: 0, lastProgressAt: 0 }

let progress: OfflineBootProgress = idle
let channel: BroadcastChannel | null = null

export function reportOfflineRebuildProgress({ done, total }: RebuildProgressMessage, now: () => number = Date.now): void {
  const at = now()
  const rebuilding = total > 0 && done < total
  const startedAt = !rebuilding ? 0 : progress.rebuilding ? progress.startedAt : at
  progress = { rebuilding, done, total, startedAt, lastProgressAt: at }
}

export function getOfflineBootProgress(): OfflineBootProgress {
  return progress
}

const stopListening = (): void => {
  channel?.close()
  channel = null
}

/**
 * Page side: start taking progress from the leader worker. Idempotent — the
 * adapter is created again on a retry, and one channel per page is enough.
 * Returns a stop function.
 */
export function listenForOfflineRebuildProgress(): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {}
  if (channel === null) {
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = (event: MessageEvent<RebuildProgressMessage>) => reportOfflineRebuildProgress(event.data)
  }
  return stopListening
}

type RehydrateHook = (progress: RebuildProgressMessage) => void

/** Leader-worker side: install the hook the @livestore/common patch calls. */
export function installRebuildProgressForwarder(now: () => number = Date.now): void {
  if (typeof BroadcastChannel === "undefined") return
  const channel = new BroadcastChannel(CHANNEL_NAME)
  let lastSentAt = -Infinity
  const hook: RehydrateHook = (message) => {
    const at = now()
    // Always send the last one, so the page sees the replay finish.
    if (message.done < message.total && at - lastSentAt < FORWARD_EVERY_MS) return
    lastSentAt = at
    channel.postMessage(message)
  }
  ;(globalThis as { __livestoreRehydrateProgress?: RehydrateHook }).__livestoreRehydrateProgress = hook
}

/** Test-only reset. */
export function __resetOfflineBootProgressForTests(): void {
  progress = idle
  stopListening()
}

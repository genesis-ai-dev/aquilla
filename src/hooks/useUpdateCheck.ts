import { useSyncExternalStore } from "react"

declare const __APP_SHA__: string

const POLL_MS = 60_000

// One poller for the whole app, however many places show the indicator
// (the left-rail VersionTag, the floating VersionBadge, the navigation
// watcher). The flag is sticky: once a newer build is seen it stays set
// until the page reloads, which is the only thing that can pick it up.
let available = false
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

async function check() {
  try {
    const res = await fetch(`/version.json?_=${Date.now()}`, { cache: "no-store" })
    if (!res.ok) return
    const { sha } = (await res.json()) as { sha?: string }
    if (sha && sha !== __APP_SHA__ && !available) {
      available = true
      for (const listener of listeners) listener()
    }
  } catch {
    /* network blip — retry next tick */
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!timer && !import.meta.env.DEV) timer = setInterval(() => void check(), POLL_MS)
  return () => {
    listeners.delete(listener)
    if (!listeners.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** True once a build newer than this one is deployed. Polls /version.json every minute. */
export function useUpdateCheck(): boolean {
  return useSyncExternalStore(subscribe, () => available, () => false)
}

/** Test seam: pretend the poller saw a newer build (or reset it). */
export function __setUpdateAvailableForTests(value: boolean) {
  available = value
  for (const listener of listeners) listener()
}

/**
 * Where a reload must never happen on its own: the editor. An edit in
 * flight lives in the outbox (IndexedDB) and would survive, but the
 * contributor's place, selection and focus lock would not.
 */
export function isEditorPath(pathname: string): boolean {
  return /^\/project\/[^/]+\/editor(\/|$)/.test(pathname)
}

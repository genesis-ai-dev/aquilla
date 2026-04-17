// src/lib/completion/frontier-health.ts
// Lightweight availability probe for api.frontierrnd.com. The chat-completions
// endpoint is the default LLM provider; we hit /api/v2/health once per tab
// (cached for 60s) so the UI can enable AI controls without every callsite
// making its own network check.

import { useEffect, useState } from "react"

const HEALTH_URL = "https://api.frontierrnd.com/api/v2/health"
const TTL_MS = 60_000
const TIMEOUT_MS = 3_000

interface Snapshot {
  available: boolean
  checkedAt: number
}

let snapshot: Snapshot | null = null
let inflight: Promise<boolean> | null = null

export async function checkFrontierHealth(): Promise<boolean> {
  const now = Date.now()
  if (snapshot && now - snapshot.checkedAt < TTL_MS) return snapshot.available
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      const res = await fetch(HEALTH_URL, { signal: controller.signal })
      clearTimeout(timer)
      const ok = res.ok
      snapshot = { available: ok, checkedAt: Date.now() }
      return ok
    } catch {
      snapshot = { available: false, checkedAt: Date.now() }
      return false
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Test seam — reset cached result so tests start fresh. */
export function __resetFrontierHealthForTests(): void {
  snapshot = null
  inflight = null
}

export interface FrontierHealthState {
  available: boolean
  checking: boolean
}

export function useFrontierHealth(): FrontierHealthState {
  const [available, setAvailable] = useState<boolean>(() => snapshot?.available ?? false)
  const [checking, setChecking] = useState<boolean>(() => !snapshot)

  useEffect(() => {
    let cancelled = false
    // Re-probe if the snapshot is stale or missing. checkFrontierHealth
    // handles its own dedupe + caching.
    setChecking(true)
    checkFrontierHealth().then((ok) => {
      if (cancelled) return
      setAvailable(ok)
      setChecking(false)
    })
    return () => { cancelled = true }
  }, [])

  return { available, checking }
}

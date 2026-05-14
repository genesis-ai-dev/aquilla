// src/lib/completion/frontier-health.ts
// Lightweight availability probe for the frontier-server identity worker.
// The chat-completions endpoint is the default LLM provider; we hit
// /api/v2/health once per tab (cached for 60s) so the UI can enable AI
// controls without every callsite making its own network check.
//
// Historically this probed api.frontierrnd.com — the legacy frontier-server.
// Now it probes apps/frontier-server (same JWT, same liveness signal).

import { useCallback, useEffect, useState } from "react"
import { subscribeSession } from "@/lib/frontier/session-store"
import { AUTH_BASE } from "@/lib/frontier/auth"

const HEALTH_URL = `${AUTH_BASE}/api/v2/health`
const TTL_MS = 60_000
const TIMEOUT_MS = 3_000

interface Snapshot {
  available: boolean
  checkedAt: number
}

let snapshot: Snapshot | null = null
let inflight: Promise<boolean> | null = null

export async function checkFrontierHealth(force = false): Promise<boolean> {
  const now = Date.now()
  if (!force && snapshot && now - snapshot.checkedAt < TTL_MS) return snapshot.available
  if (!force && inflight) return inflight
  if (force) {
    snapshot = null
    inflight = null
  }
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

  const probe = useCallback((force = false) => {
    let cancelled = false
    setChecking(true)
    checkFrontierHealth(force).then((ok) => {
      if (cancelled) return
      setAvailable(ok)
      setChecking(false)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => probe(), [probe])

  // The probe result is cached for 60s. If the user signs in (or switches
  // accounts) while the cache holds a stale "unavailable" result — say the
  // initial probe ran during a transient hiccup — the AI controls would stay
  // off until the TTL elapses or the page is refreshed. Re-probe with a
  // forced refresh on every session change so login flips the controls live.
  useEffect(() => {
    return subscribeSession(() => probe(true))
  }, [probe])

  return { available, checking }
}

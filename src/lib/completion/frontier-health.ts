// src/lib/completion/frontier-health.ts
// Lightweight availability probe for the aquilla-identity health endpoint.
// We hit /api/v2/health once per tab (cached for 60s) so the UI can enable AI
// controls without every callsite making its own network check.

import { useCallback, useEffect, useState } from "react"
import { subscribeSession } from "@/lib/frontier/session-store"
import { AUTH_BASE } from "@/lib/frontier/auth"

// Phase D: repoint from api.frontierrnd.com to the local identity worker.
const HEALTH_URL = `${AUTH_BASE}/api/v2/health`
const TTL_MS = 60_000
const TIMEOUT_MS = 3_000

interface Snapshot {
  available: boolean
  checkedAt: number
}

let snapshot: Snapshot | null = null
let inflight: Promise<boolean> | null = null

/**
 * AQU-1377: a probe that runs while the browser is offline can only fail, and
 * caching that failure is what strands the AI controls. Turning Wi-Fi off/on at
 * the OS level takes the tab out of and back into focus, and the session store
 * notifies on `focus`/`visibilitychange` — so a FORCED probe fires while the
 * network is down (or in the first seconds after reconnect, before it is
 * usable). Writing `available: false` with a fresh timestamp then serves a
 * stale negative for the whole TTL, and nothing re-probes until the next focus
 * change: the click becomes a silent no-op until a reload.
 *
 * So while `navigator.onLine` is false we answer "unavailable" WITHOUT recording
 * a snapshot. The negative is still correct for the caller, but it never ages
 * into a cached truth — the next probe after reconnect really hits the network.
 * That makes recovery hold even if the `online` event below is missed entirely.
 */
function isBrowserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false
}

export async function checkFrontierHealth(force = false): Promise<boolean> {
  // Ahead of the cache on purpose: with no network the service IS unreachable,
  // whatever a snapshot from up to 60s ago says. Answering from a cached
  // positive here would let a batch start offline and fail per-cell instead of
  // telling the user plainly that they are offline. Leaving the snapshot
  // untouched is what lets the controls come straight back on reconnect.
  if (isBrowserOffline()) return false
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

  // AQU-1377: recover on reconnect. Nothing used to subscribe to the browser's
  // `online` event, so after an offline → online cycle the cached "unavailable"
  // only cleared on the next focus change or session write — and only if the
  // network happened to be back by then. A page reload remounted the hook and
  // probed fresh, which is why a refresh "fixed" it. Probing here (forced, so
  // it bypasses the TTL) flips the AI controls back on without one.
  useEffect(() => {
    const onOnline = () => probe(true)
    window.addEventListener("online", onOnline)
    return () => window.removeEventListener("online", onOnline)
  }, [probe])

  return { available, checking }
}

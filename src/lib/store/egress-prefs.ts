/**
 * egress-prefs — per-org "Data egress" export options.
 *
 * Stored in localStorage keyed by orgId so each organization keeps its own
 * export configuration between visits (an org exporting audio stems shouldn't
 * reconfigure after visiting a text-only org). Reactive via
 * useSyncExternalStore so any write immediately updates every mounted reader.
 *
 * Key schema: `aq.egress-prefs.v1`
 */

import { useSyncExternalStore } from "react"
import type { EgressOptions } from "@/lib/egress/types"

const STORAGE_KEY = "aq.egress-prefs.v1"

/** Fresh-org defaults: round-trip text on the default lane, no audio, cache on. */
export const DEFAULT_EGRESS_OPTIONS: EgressOptions = Object.freeze({
  textMode: "original",
  convertFormat: "txt",
  lanes: [""],
  includeSourceDocs: false,
  audioMode: "none",
  useCache: true,
}) as EgressOptions

type PrefMap = Record<string, EgressOptions>

// ── Internal cache + listeners ──────────────────────────────────────────────

const snapshotCache = new Map<number, EgressOptions | null>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function load(): PrefMap {
  if (typeof localStorage === "undefined") return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as PrefMap
  } catch {
    return {}
  }
}

function save(map: PrefMap): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // quota / access denied — in-memory cache still reflects the edit
  }
}

function peek(orgId: number): EgressOptions | null {
  const cached = snapshotCache.get(orgId)
  if (cached !== undefined) return cached
  const fromLs = load()[String(orgId)] ?? null
  snapshotCache.set(orgId, fromLs)
  return fromLs
}

// ── Public API ───────────────────────────────────────────────────────────────

/** The org's saved options, or null when never saved (caller applies defaults). */
export function getEgressPrefs(orgId: number): EgressOptions | null {
  return peek(orgId)
}

export function setEgressPrefs(orgId: number, options: EgressOptions): void {
  const map = load()
  map[String(orgId)] = options
  save(map)
  snapshotCache.set(orgId, options)
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Subscribe to one org's egress options (null when unset / no org). */
export function useEgressPrefs(orgId: number | null): EgressOptions | null {
  return useSyncExternalStore(
    subscribe,
    () => (orgId != null ? peek(orgId) : null),
    () => null,
  )
}

/** Test-only: drop the module-level cache so localStorage.clear() takes effect. */
export function _resetEgressPrefsForTests(): void {
  snapshotCache.clear()
}

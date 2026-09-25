/**
 * cell-display-fields — which cell-metadata keys a project shows as labels on
 * its cells (AQU-1369).
 *
 * A key is switched on from ANY cell's Metadata tab and then labels every cell
 * in the project that carries that key; switching it off from any cell clears
 * it everywhere. It is a display setting, never a data change — the metadata
 * itself is untouched.
 *
 * Scope is the project: keyed by projectId, never by file or cell. Stored in
 * localStorage so it survives reloads; device-local like the other editor
 * display prefs in this folder. Reactive via useSyncExternalStore so a toggle
 * on one row re-renders every mounted row at once.
 *
 * Key schema: `aq.cell-display-fields.v1` → { [projectId]: string[] }
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.cell-display-fields.v1"

type FieldMap = Record<string, string[]>

const EMPTY: readonly string[] = Object.freeze([])

// ── Internal cache + listeners ──────────────────────────────────────────────

const snapshotCache = new Map<string, readonly string[]>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function load(): FieldMap {
  if (typeof localStorage === "undefined") return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as FieldMap)
      : {}
  } catch {
    return {}
  }
}

function save(map: FieldMap): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // quota / access denied — in-memory cache still reflects the edit
  }
}

function peek(projectId: string): readonly string[] {
  const cached = snapshotCache.get(projectId)
  if (cached) return cached
  const stored = load()[projectId]
  const fields = Array.isArray(stored)
    ? Object.freeze(stored.filter((k): k is string => typeof k === "string"))
    : EMPTY
  snapshotCache.set(projectId, fields)
  return fields
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** The metadata keys this project shows as cell labels, in the order switched on. */
export function getCellDisplayFields(projectId: string): readonly string[] {
  return peek(projectId)
}

/** Switch one metadata key's cell label on or off for the whole project. */
export function setCellDisplayField(projectId: string, key: string, enabled: boolean): void {
  const current = peek(projectId)
  if (current.includes(key) === enabled) return
  const next = enabled ? [...current, key] : current.filter((k) => k !== key)
  const map = load()
  if (next.length === 0) delete map[projectId]
  else map[projectId] = next
  save(map)
  snapshotCache.set(projectId, next.length ? Object.freeze(next) : EMPTY)
  notify()
}

/** Subscribe to a project's display fields. Stable array (EMPTY when unset). */
export function useCellDisplayFields(projectId: string | null | undefined): readonly string[] {
  return useSyncExternalStore(
    subscribe,
    () => (projectId ? peek(projectId) : EMPTY),
    () => EMPTY,
  )
}

/**
 * The label text a metadata value shows on a cell, or null when it has none.
 * Only scalar values and flat lists of scalars make a readable label; nested
 * objects stay in the Metadata tab rather than becoming a JSON blob on the row.
 */
export function displayFieldLabel(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) {
    // A nested list or object inside the list is not flat — no label.
    if (value.some((item) => item != null && typeof item === "object")) return null
    const parts = value
      .map((item) => displayFieldLabel(item))
      .filter((part): part is string => part != null)
    return parts.length ? parts.join(", ") : null
  }
  return null
}

/** Test-only: drop the in-memory cache so the next read reloads storage. */
export function __resetCellDisplayFieldsCache(): void {
  snapshotCache.clear()
}

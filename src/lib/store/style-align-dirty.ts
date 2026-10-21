/**
 * Cells whose translator typed into a merged plain run and left the words in
 * fewer underlying slots than the source uses. The corner warning reads this.
 *
 * The value is a hash of the target HTML that was typed, so a later AI draft
 * or Align styles result — a different HTML string — does not keep the warning.
 * Absent means the cell does not need the warning.
 *
 * Key schema: `aq.style-align-dirty.v1` (JSON map of cell id → hash).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.style-align-dirty.v1"
const MANUAL_KEY = "aq.style-align-manual.v1"

const listeners = new Set<() => void>()

const EMPTY: Record<string, string> = {}
const EMPTY_MANUAL: ReadonlySet<string> = new Set()

let cached: Record<string, string> | undefined
let manualCached: ReadonlySet<string> | undefined

function hashHtml(html: string): string {
  let hash = 5381
  for (let i = 0; i < html.length; i++) {
    hash = Math.imul(hash, 33) ^ html.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

function read(): Record<string, string> {
  if (typeof localStorage === "undefined") return EMPTY
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY
    const map: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") map[key] = value
    }
    return map
  } catch {
    return EMPTY
  }
}

function peek(): Record<string, string> {
  if (!cached) cached = read()
  return cached
}

function write(next: Record<string, string>): void {
  cached = next
  if (typeof localStorage !== "undefined") {
    try {
      if (Object.keys(next).length === 0) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // quota / access denied — the in-memory map still reflects the edit
    }
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function markStyleAlignDirty(cellId: string, html: string): void {
  const hash = hashHtml(html)
  const current = peek()
  if (current[cellId] === hash) return
  write({ ...current, [cellId]: hash })
}

export function clearStyleAlignDirty(cellId: string): void {
  const current = peek()
  if (!(cellId in current)) return
  const next = { ...current }
  delete next[cellId]
  write(next)
}

export function styleAlignDirtyMatches(cellId: string, html: string | undefined): boolean {
  if (!html) return false
  return peek()[cellId] === hashHtml(html)
}

export function useStyleAlignDirtyMatch(cellId: string, html: string | undefined): boolean {
  const map = useSyncExternalStore(subscribe, peek, () => EMPTY)
  if (!html) return false
  return map[cellId] === hashHtml(html)
}

function readManual(): ReadonlySet<string> {
  if (typeof localStorage === "undefined") return EMPTY_MANUAL
  try {
    const raw = localStorage.getItem(MANUAL_KEY)
    if (!raw) return EMPTY_MANUAL
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return EMPTY_MANUAL
    return new Set(parsed.filter((id): id is string => typeof id === "string"))
  } catch {
    return EMPTY_MANUAL
  }
}

function peekManual(): ReadonlySet<string> {
  if (!manualCached) manualCached = readManual()
  return manualCached
}

function writeManual(next: ReadonlySet<string>): void {
  manualCached = next
  if (typeof localStorage !== "undefined") {
    try {
      if (next.size === 0) localStorage.removeItem(MANUAL_KEY)
      else localStorage.setItem(MANUAL_KEY, JSON.stringify([...next]))
    } catch {
      // quota / access denied — the in-memory set still reflects the edit
    }
  }
  for (const listener of listeners) listener()
}

/** A re-import left this cell's translation in place because Align styles could not run. */
export function markManualStyleAlign(cellId: string): void {
  const current = peekManual()
  if (current.has(cellId)) return
  writeManual(new Set([...current, cellId]))
}

export function clearManualStyleAlign(cellId: string): void {
  const current = peekManual()
  if (!current.has(cellId)) return
  const next = new Set(current)
  next.delete(cellId)
  writeManual(next)
}

export function useManualStyleAlign(cellId: string): boolean {
  const ids = useSyncExternalStore(subscribe, peekManual, () => EMPTY_MANUAL)
  return ids.has(cellId)
}

export function resetStyleAlignDirtyForTests(): void {
  cached = undefined
  manualCached = undefined
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(STORAGE_KEY)
      localStorage.removeItem(MANUAL_KEY)
    } catch {
      // ignore
    }
  }
  for (const listener of listeners) listener()
}

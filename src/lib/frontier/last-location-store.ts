/**
 * last-location-store — per-user, per-project LRU localStorage store.
 *
 * Keeps the user's last-known position inside each project so that
 * re-opening a project resumes at the remembered file (and cell, if
 * available).
 *
 * Key schema: `aq.lastloc.v1`
 * Value:      LRU array capped at MAX_ENTRIES, most-recent first.
 */

const STORAGE_KEY = "aq.lastloc.v1"
const MAX_ENTRIES = 50

export interface LastLocation {
  fileId: string
  cellId?: string
  /** USFM canonical ref, e.g. "GEN 1:1" — informational, not used for nav */
  canonicalRef?: string
}

interface Entry {
  userId: string
  projectId: string
  loc: LastLocation
}

// ---- storage helpers --------------------------------------------------------

function readAll(): Entry[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Entry[]) : []
  } catch {
    return []
  }
}

function writeAll(entries: Entry[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // localStorage full / disabled — non-fatal
  }
}

// ---- public API -------------------------------------------------------------

/** Read the last-known location for a user+project pair. Returns null when
 *  no entry exists. */
export function readLastLocation(
  userId: string,
  projectId: string,
): LastLocation | null {
  const entries = readAll()
  const found = entries.find(
    (e) => e.userId === userId && e.projectId === projectId,
  )
  return found?.loc ?? null
}

export function clearLastLocation(
  userId: string,
  projectId: string,
): void {
  const entries = readAll()
  const filtered = entries.filter(
    (e) => !(e.userId === userId && e.projectId === projectId),
  )
  if (filtered.length !== entries.length) writeAll(filtered)
}

/** Write (or update) the last-known location for a user+project pair.
 *  The entry is promoted to the front of the LRU list. The list is capped
 *  at MAX_ENTRIES (oldest entries dropped when over the limit). */
export function writeLastLocation(
  userId: string,
  projectId: string,
  loc: LastLocation,
): void {
  const entries = readAll()
  // Remove existing entry for this user+project (if any) then prepend.
  const filtered = entries.filter(
    (e) => !(e.userId === userId && e.projectId === projectId),
  )
  const next: Entry[] = [{ userId, projectId, loc }, ...filtered].slice(
    0,
    MAX_ENTRIES,
  )
  writeAll(next)
}

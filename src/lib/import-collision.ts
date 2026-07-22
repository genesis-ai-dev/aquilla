/**
 * AQU-287 — Re-import collision detection.
 *
 * Pure helpers: no network I/O, no React, no side effects.
 *
 * Matching rules (in priority order):
 *   1. bookCode match — both sides have a non-empty bookCode and they're equal
 *      (case-insensitive, trimmed).  This is the primary key for USFM files.
 *   2. Normalized-name match — lowercase + trim the display name; matches when
 *      both sides resolve to the same string.  Fallback for non-USFM formats
 *      (DOCX, TXT, VTT…) and for projects where bookCode is absent.
 *
 * A fresh project with no existing files produces zero collisions — the fast
 * path returns immediately without iterating the incoming list.
 */

export interface CollisionCandidate {
  /** Existing file id. Incoming candidates omit it. */
  id?: string
  /** Incoming display name. */
  name: string
  /** USFM book code, e.g. "GEN". Present for USFM/Paratext imports. */
  bookCode?: string
}

export interface CollisionResult {
  /** Display name of the incoming item (same as candidate.name). */
  name: string
  bookCode?: string
  /** Display name of the existing file that matched. */
  existingName: string
  /** Existing file id, when supplied by the project listing. Required for a
   * safe in-place re-import; legacy callers that only know names omit it. */
  existingId?: string
  /** More than one existing file matched this identity. In-place update is
   * unavailable rather than choosing an arbitrary file. */
  ambiguous?: boolean
}

function addUniqueCandidate(
  index: Map<string, CollisionCandidate | null>,
  key: string,
  candidate: CollisionCandidate,
): void {
  const prior = index.get(key)
  if (prior === undefined) index.set(key, candidate)
  else if (prior === null || prior.id !== candidate.id || prior.name !== candidate.name) index.set(key, null)
}

/**
 * Compare incoming items against existing project files and return the subset
 * that would collide.
 *
 * @param incoming  The files/books about to be imported.
 * @param existing  Files already in the project (FileReference[] is fine — only
 *                  `name` and optional `bookCode` are used).
 */
export function detectCollisions(
  incoming: CollisionCandidate[],
  existing: CollisionCandidate[],
): CollisionResult[] {
  // Fast path: empty project or empty incoming → no collisions.
  if (existing.length === 0 || incoming.length === 0) return []

  // Build lookup structures once for O(1) inner loop.
  const byBookCode = new Map<string, CollisionCandidate | null>()
  const byNormalName = new Map<string, CollisionCandidate | null>()
  for (const e of existing) {
    if (e.bookCode) addUniqueCandidate(byBookCode, e.bookCode.trim().toUpperCase(), e)
    addUniqueCandidate(byNormalName, e.name.trim().toLowerCase(), e)
  }

  const results: CollisionResult[] = []
  for (const c of incoming) {
    const key = c.bookCode?.trim().toUpperCase()
    const nameKey = c.name.trim().toLowerCase()

    const match = key && byBookCode.has(key)
      ? byBookCode.get(key)
      : byNormalName.get(nameKey)

    if (match === null) {
      results.push({
        name: c.name,
        bookCode: c.bookCode,
        existingName: "Multiple matching files",
        ambiguous: true,
      })
    } else if (match !== undefined) {
      results.push({
        name: c.name,
        bookCode: c.bookCode,
        existingName: match.name,
        ...(match.id ? { existingId: match.id } : {}),
      })
    }
  }
  return results
}

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
  const byBookCode = new Map<string, string>() // bookCode → existingName
  const byNormalName = new Map<string, string>() // normalizedName → existingName
  for (const e of existing) {
    if (e.bookCode) byBookCode.set(e.bookCode.trim().toUpperCase(), e.name)
    byNormalName.set(e.name.trim().toLowerCase(), e.name)
  }

  const results: CollisionResult[] = []
  for (const c of incoming) {
    const key = c.bookCode?.trim().toUpperCase()
    const nameKey = c.name.trim().toLowerCase()

    const existingName =
      (key ? byBookCode.get(key) : undefined) ??
      byNormalName.get(nameKey)

    if (existingName !== undefined) {
      results.push({ name: c.name, bookCode: c.bookCode, existingName })
    }
  }
  return results
}

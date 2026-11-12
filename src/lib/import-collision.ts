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
 *   3. Workbook-sheet match (AQU-2120) — an incoming `.xlsx` matches an
 *      existing file the spreadsheet importer named after one of its sheets
 *      ("data.xlsx" → "data.xlsx — Sheet1"), so re-importing a workbook is
 *      caught instead of silently making a second file.
 *
 * A collision only offers an `existingId` when that kind of file can actually
 * be re-imported in place (AQU-2120) — media cannot, so it is reported
 * without one.
 *
 * A fresh project with no existing files produces zero collisions — the fast
 * path returns immediately without iterating the incoming list.
 */

import { detectFileType, isMediaFileType } from "./parsers/types"

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
  /** AQU-2120: this kind of file has no in-place re-import path, so no
   * `existingId` is offered however exactly the names match. */
  updateUnsupported?: true
}

/**
 * How `SpreadsheetImportPanel` names one sheet of a workbook:
 * `<file name> — <sheet name>`. Shared with the importer so "what collides"
 * and "what gets written" can never drift apart (AQU-2120).
 */
export const SHEET_NAME_SEPARATOR = " — "

/**
 * Can this file be re-imported into an existing file in place?
 *
 * AQU-2120: media cannot. `emitMediaFile` always mints a new file id — a
 * media file's cells are a timeline, not the stable units reconciliation
 * matches on — so offering "Update existing" for an audio or video file
 * quietly produced a second file with the same name. Report the collision
 * without an `existingId` so only Skip and Import as duplicate are offered.
 */
export function supportsInPlaceReimport(name: string): boolean {
  const fileType = detectFileType(name)
  return !(fileType && isMediaFileType(fileType))
}

/** The workbook an existing sheet file was imported from, for a name carrying
 *  a sheet suffix ("data.xlsx — Sheet1" → "data.xlsx"). */
function workbookBaseName(name: string): string | undefined {
  const at = name.indexOf(SHEET_NAME_SEPARATOR)
  return at > 0 ? name.slice(0, at) : undefined
}

/** Only a workbook is imported one sheet at a time, so only a workbook name is
 *  looked up against the sheet index. CSV/TSV keep the file's own name. */
function isWorkbookName(name: string): boolean {
  return /\.xlsx$/i.test(name.trim())
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
  const bySheetBase = new Map<string, CollisionCandidate | null>()
  for (const e of existing) {
    if (e.bookCode) addUniqueCandidate(byBookCode, e.bookCode.trim().toUpperCase(), e)
    addUniqueCandidate(byNormalName, e.name.trim().toLowerCase(), e)
    const base = workbookBaseName(e.name)
    if (base) addUniqueCandidate(bySheetBase, base.trim().toLowerCase(), e)
  }

  const results: CollisionResult[] = []
  for (const c of incoming) {
    const key = c.bookCode?.trim().toUpperCase()
    const nameKey = c.name.trim().toLowerCase()

    // Explicit `has` checks rather than `??`: a `null` entry means "several
    // existing files match", which must not fall through to the next index.
    let match: CollisionCandidate | null | undefined
    if (key && byBookCode.has(key)) match = byBookCode.get(key)
    else if (byNormalName.has(nameKey)) match = byNormalName.get(nameKey)
    else if (isWorkbookName(c.name)) match = bySheetBase.get(nameKey)

    if (match === null) {
      results.push({
        name: c.name,
        bookCode: c.bookCode,
        existingName: "Multiple matching files",
        ambiguous: true,
      })
    } else if (match !== undefined) {
      const updatable = supportsInPlaceReimport(c.name)
      results.push({
        name: c.name,
        bookCode: c.bookCode,
        existingName: match.name,
        ...(match.id && updatable ? { existingId: match.id } : {}),
        ...(updatable ? {} : { updateUnsupported: true as const }),
      })
    }
  }
  return results
}

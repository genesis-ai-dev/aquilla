// DCS upstream cursor read/write (spec §8). The cursor pins an adapter project
// to a Door43 release (tag/sha); it lives in the adapter project's
// project_settings under the "dcsUpstream" key (JSONB — no schema migration).
//
// These are PURE functions over a plain settings object so they're trivially
// testable and don't couple to the network or the settings hook. The Slice B/C
// wiring reads/writes the settings blob; this module only shapes it.

import type { DcsCatalogEntry, DcsCursor, DcsTrackMode } from "./types"

/** project_settings key under which the cursor is stored. */
export const DCS_UPSTREAM_KEY = "dcsUpstream"

/** A settings bag that may carry the dcsUpstream cursor. */
export type DcsSettingsLike = Record<string, unknown> | null | undefined

function isCursor(v: unknown): v is DcsCursor {
  if (typeof v !== "object" || v === null) return false
  const c = v as Record<string, unknown>
  return (
    typeof c.owner === "string" &&
    typeof c.repo === "string" &&
    typeof c.ref === "string" &&
    typeof c.commitSha === "string"
  )
}

/** Read the pinned cursor from a project's settings blob, or null if absent /
 *  malformed. */
export function readCursor(settings: DcsSettingsLike): DcsCursor | null {
  if (!settings) return null
  const raw = settings[DCS_UPSTREAM_KEY]
  return isCursor(raw) ? raw : null
}

/** Build the cursor to persist for a fresh import / re-pin of a catalog entry. */
export function buildCursor(entry: DcsCatalogEntry, trackMode: DcsTrackMode): DcsCursor {
  return {
    owner: entry.owner,
    repo: entry.name,
    subject: entry.subject,
    contentFormat: entry.contentFormat,
    trackMode,
    ref: entry.ref,
    commitSha: entry.commitSha,
    released: entry.released,
    importedAt: new Date().toISOString(),
  }
}

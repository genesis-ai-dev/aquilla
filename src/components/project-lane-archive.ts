// AQU-601: language-lane archiving.
//
// A project's extra target lanes live in `settings.targetLanes` (the canonical
// registry — see AQU-538). Deleting a lane outright would lose the tie between
// the lane and any committed target cell data and make a mistyped/wrong lane
// unrecoverable. The product decision (AQU-601) is an ARCHIVE path instead:
//
//   • Archiving a lane records its tag in `settings.archivedLanes` — it STAYS
//     in `targetLanes`, so its cell data and every existing consumer (the
//     `?lane=` deep-link resolver, org rollups, assign/share pickers) keep
//     seeing it. Nothing is destroyed.
//   • Surfaces that opt in (the workspace lane switcher, the settings manager)
//     treat archived lanes as hidden-by-default but still findable: the switcher
//     tucks them behind a "show archived" reveal; settings lists them under a
//     restore control.
//
// This module is the single, pure, unit-tested source of the active/archived
// split so those surfaces stay consistent.

/** Case-insensitive membership test against the archived-lane set. The default
 *  lane (`''`) is never archivable, so it always reports false. */
export function isLaneArchived(
  lane: string,
  archivedLanes: readonly string[] | undefined,
): boolean {
  if (!lane || !archivedLanes || archivedLanes.length === 0) return false
  const lower = lane.toLowerCase()
  return archivedLanes.some((l) => l.toLowerCase() === lower)
}

/** The lanes a surface should show by default: registered lanes minus the
 *  archived ones, in registry order. Preserves the input order. */
export function activeLanes(
  targetLanes: readonly string[],
  archivedLanes: readonly string[] | undefined,
): string[] {
  if (!archivedLanes || archivedLanes.length === 0) return [...targetLanes]
  return targetLanes.filter((l) => !isLaneArchived(l, archivedLanes))
}

/** The archived lanes among the registered lanes, in registry order. Only tags
 *  that are actually registered are returned — a stale `archivedLanes` entry for
 *  a lane no longer in `targetLanes` is ignored so it can't render a ghost row. */
export function archivedRegisteredLanes(
  targetLanes: readonly string[],
  archivedLanes: readonly string[] | undefined,
): string[] {
  if (!archivedLanes || archivedLanes.length === 0) return []
  return targetLanes.filter((l) => isLaneArchived(l, archivedLanes))
}

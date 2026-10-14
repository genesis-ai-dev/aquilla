/**
 * AQU-1463: the member-facing half of an archived lane.
 *
 * AQU-1462 made the server refuse a write that names an archived lane. This
 * module is the client's side of that same contract: while the editor is
 * pointed at an archived lane the UI stops offering the actions the server
 * would refuse, and it tells the member once, the moment the archive arrives,
 * instead of letting them keep typing into a frozen lane.
 *
 * Nothing here reads the DOM or React state. The lock is a pure function of
 * the active lane and the archived-lane list the workspace already derives
 * from the lane rows (`lanes.archived_at`), so it re-evaluates for free when
 * the `project.settings.updated` frame lands and the rows are re-read — that
 * is what makes the lock live, with no reload and no polling.
 *
 * ## Which writes the lock covers
 *
 * It asks `archived-lane.ts` — the module the sync-worker's authorizer asks —
 * rather than keeping a second list of event kinds. A kind the server would
 * freeze for this lane is a kind the client must not offer; a kind it would
 * let through (a shared write, or a named-lane kind on the default lane) stays
 * available. Comments are not lane writes at all and are never covered: they
 * are shared across lanes, so a member keeps commenting on a frozen lane.
 *
 * ## When the member is told
 *
 * The must-dismiss modal is for the member who was *working in* the lane when
 * it was frozen. `LaneArchiveWatch` is the bookkeeping that distinguishes that
 * from the three cases where a modal would be noise:
 *
 *   • a cold open on an already-archived lane (reload, deep link, "show
 *     archived") — the member is choosing to look at it, so the banner alone;
 *   • switching back to a lane they have already acknowledged;
 *   • an archive of a lane they are not even looking at.
 *
 * The watch is session state, deliberately not persisted: a reload is a cold
 * open, which is the first case.
 */

import { isLaneArchived } from "@/components/project-lane-archive"
import { laneTagForArchiveCheck } from "./archived-lane"

/** The lane the editor is pointed at, frozen. */
export interface LaneLock {
  /** The locked lane's tag. `''` is the former default lane (AQU-1600). */
  tag: string
  /** How the lane is named to the member — the switcher's own label. */
  label: string
}

/**
 * The lock for the lane the editor is pointed at, or null when that lane is
 * open for business.
 *
 * `archivedLanes` is the tag list the workspace derives from the lane rows.
 * It can legitimately name the empty tag, because the former default lane is
 * archivable; `isLaneArchived` matches it like any other.
 */
export function laneLockFor(input: {
  activeLane: string
  archivedLanes: readonly string[] | undefined
  /** The label this surface shows for `activeLane`. */
  label: string
}): LaneLock | null {
  if (!isLaneArchived(input.activeLane, input.archivedLanes)) return null
  return { tag: input.activeLane, label: input.label }
}

/**
 * Whether a write of `kind` into the locked lane must not be offered.
 *
 * Delegates the kind table to `laneTagForArchiveCheck`, the same function
 * `sync-worker/src/events/authorize.ts` uses to decide whether the archived
 * check applies to an incoming event. A null tag there means the write is
 * shared rather than lane-scoped, and a shared write is not frozen — so the
 * client offers exactly what the server would accept.
 */
export function laneWriteLocked(kind: string, lock: LaneLock | null): boolean {
  if (!lock) return false
  return laneTagForArchiveCheck(kind, { targetLang: lock.tag }) !== null
}

/**
 * Session bookkeeping behind the must-dismiss modal.
 *
 * `seenActive` is the set of lanes this session has watched while they were
 * still active — the only lanes whose archive is news. `acknowledged` is the
 * lanes whose modal has been dismissed.
 */
export interface LaneArchiveWatch {
  readonly seenActive: ReadonlySet<string>
  readonly acknowledged: ReadonlySet<string>
}

export function laneArchiveWatchInit(): LaneArchiveWatch {
  return { seenActive: new Set(), acknowledged: new Set() }
}

/**
 * Fold the current view into the watch. Call it whenever the active lane or
 * the archived-lane list changes.
 *
 * Seeing a lane active both arms its modal and disarms any earlier
 * acknowledgement, so a restore followed by a second archive is announced
 * again — the member is being interrupted a second time because they were
 * genuinely working in the lane a second time.
 *
 * Returns the same object when nothing changed, so a caller can store it in
 * React state without re-rendering on every settings frame.
 */
export function observeLaneArchive(
  watch: LaneArchiveWatch,
  input: { activeLane: string; locked: boolean },
): LaneArchiveWatch {
  if (input.locked) return watch
  const alreadySeen = watch.seenActive.has(input.activeLane)
  const stillAcknowledged = watch.acknowledged.has(input.activeLane)
  if (alreadySeen && !stillAcknowledged) return watch
  const seenActive = new Set(watch.seenActive)
  seenActive.add(input.activeLane)
  const acknowledged = new Set(watch.acknowledged)
  acknowledged.delete(input.activeLane)
  return { seenActive, acknowledged }
}

/** Record that the member dismissed the modal for `tag`. */
export function acknowledgeLaneArchive(
  watch: LaneArchiveWatch,
  tag: string,
): LaneArchiveWatch {
  if (watch.acknowledged.has(tag)) return watch
  const acknowledged = new Set(watch.acknowledged)
  acknowledged.add(tag)
  return { ...watch, acknowledged }
}

/**
 * The lock to interrupt the member about, or null when the banner is enough.
 *
 * Non-null only for a lane this session watched while it was active and whose
 * modal has not been dismissed.
 */
export function laneArchiveToAnnounce(
  watch: LaneArchiveWatch,
  lock: LaneLock | null,
): LaneLock | null {
  if (!lock) return null
  if (!watch.seenActive.has(lock.tag)) return null
  if (watch.acknowledged.has(lock.tag)) return null
  return lock
}

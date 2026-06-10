/**
 * Pure helpers for updating the cellLockHolders Map from WS frames.
 *
 * B4 fix: every function returns a NEW Map — never mutates the input.
 * This ensures React's functional-updater bail-out (reference equality check)
 * always sees a changed object and triggers a re-render.
 *
 * RACE-5 contract: callers assign the returned Map to cellLockHoldersRef.current
 * SYNCHRONOUSLY and pass the same object (or the return value directly) to
 * setCellLockHolders — so the ref is never stale relative to React state.
 */

/** Shape expected from a presence-frame user entry. */
export interface PresenceUser {
  userId: string
  focusedCell?: string
}

/**
 * Build a fresh lock-holders map from a presence broadcast.
 * Only users who have a focusedCell that differs from currentUsername are included.
 */
export function applyPresenceFrame(
  users: PresenceUser[],
  currentUsername: string,
): Map<string, string> {
  const next = new Map<string, string>()
  for (const u of users) {
    if (!u.focusedCell) continue
    if (u.userId === currentUsername) continue
    next.set(u.focusedCell, u.userId)
  }
  return next
}

/**
 * Build a fresh lock-holders map with a new claim applied.
 * Returns a new Map regardless of whether the entry already existed.
 */
export function applyLockClaimed(
  current: ReadonlyMap<string, string>,
  cellId: string,
  userId: string,
): Map<string, string> {
  const next = new Map(current)
  next.set(cellId, userId)
  return next
}

/**
 * Build a fresh lock-holders map with an entry removed.
 * Returns a new Map regardless of whether the entry existed.
 */
export function applyLockReleased(
  current: ReadonlyMap<string, string>,
  cellId: string,
): Map<string, string> {
  const next = new Map(current)
  next.delete(cellId)
  return next
}

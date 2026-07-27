/**
 * opened-shared-store — per-user, per-project record of when the caller last
 * "opened" (landed on) a project. Used to clear the "New" badge shown on a
 * newly-shared project once the user has actually opened it (AQU-696).
 *
 * Modeled on `last-location-store`: a per-user, per-project LRU array in
 * localStorage, keyed on the session username. Deliberately NOT stored in the
 * IndexedDB project index — that store is wiped on logout / account switch,
 * which would resurrect the "New" badge for every shared project after a
 * sign-out. localStorage survives sign-out, so the "opened" record persists.
 *
 * Key schema: `aq.opened-shared.v1`
 * Value:      LRU array capped at MAX_ENTRIES, most-recent first.
 */

const STORAGE_KEY = "aq.opened-shared.v1"
// Generous cap: a user rarely has hundreds of shared projects, and evicting an
// "opened" record would incorrectly re-light the badge for that project.
const MAX_ENTRIES = 500

interface OpenedEntry {
  userId: string
  projectId: string
  /** Epoch milliseconds when the project was last opened by this user. */
  openedAt: number
}

// ---- storage helpers --------------------------------------------------------

function readAll(): OpenedEntry[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as OpenedEntry[]) : []
  } catch {
    return []
  }
}

function writeAll(entries: OpenedEntry[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // localStorage full / disabled — non-fatal
  }
}

// ---- public API -------------------------------------------------------------

/** Read when the user last opened a project. Returns null when no record
 *  exists (never opened by this user). */
export function readProjectOpenedAt(
  userId: string,
  projectId: string,
): number | null {
  const entries = readAll()
  const found = entries.find(
    (e) => e.userId === userId && e.projectId === projectId,
  )
  return typeof found?.openedAt === "number" ? found.openedAt : null
}

/** Record that the user opened a project now (or at `at`). The entry is
 *  promoted to the front of the LRU list, which is capped at MAX_ENTRIES. */
export function markProjectOpened(
  userId: string,
  projectId: string,
  at: number = Date.now(),
): void {
  if (!userId || !projectId) return
  const entries = readAll()
  const filtered = entries.filter(
    (e) => !(e.userId === userId && e.projectId === projectId),
  )
  const next: OpenedEntry[] = [
    { userId, projectId, openedAt: at },
    ...filtered,
  ].slice(0, MAX_ENTRIES)
  writeAll(next)
}

/**
 * Decide whether a shared project should read as "new": the caller has been
 * granted access and has not opened it since that grant.
 *
 * - No grant timestamp (older worker deployment, or unavailable) ⇒ **not new**
 *   — graceful degradation, so a missing field never lights up the whole list.
 * - Never opened ⇒ new.
 * - Opened, but before the grant (e.g. access removed then re-granted) ⇒ new
 *   again.
 */
export function isProjectNew(
  grantedAt: string | null | undefined,
  openedAt: number | null,
): boolean {
  if (!grantedAt) return false
  const grantedMs = Date.parse(grantedAt)
  if (Number.isNaN(grantedMs)) return false
  if (openedAt == null) return true
  return openedAt < grantedMs
}

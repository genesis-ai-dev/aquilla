// AQU-646 stage 2: which folders this person has closed.
//
// PERSONAL, NOT SYNCED, and that is the one design decision here. Folder
// MEMBERSHIP is project structure — a maintainer decides that a file's tracks
// are grouped this way, and everyone sees it. Whether a given folder is open
// on a given screen is not structure, it is where somebody is looking, and
// syncing it would mean a collaborator's timeline folding up under them while
// they worked. Logic gets this right and so does every file browser ever
// written.
//
// PER FILE, unlike the snap preference beside it. Snapping is an editing-MODE
// choice that means the same thing everywhere; a folder id only exists on the
// file that has it, so one shared set would be a growing bag of ids from every
// project the person has ever opened, most of them meaningless.

const KEY_PREFIX = "aquilla:tlFoldersClosed:"

const keyFor = (fileId: string) => `${KEY_PREFIX}${fileId}`

/** The folder ids this person has closed on this file. Always a real Set —
 *  private mode, a cleared store and a corrupt value all read as "nothing is
 *  closed", which is the state that hides no track from anybody. */
export function loadCollapsedFolders(fileId: string | null | undefined): ReadonlySet<string> {
  if (!fileId) return new Set()
  try {
    const raw = localStorage.getItem(keyFor(fileId))
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === "string"))
  } catch {
    return new Set()
  }
}

export function saveCollapsedFolders(fileId: string | null | undefined, ids: ReadonlySet<string>): void {
  if (!fileId) return
  try {
    // An empty set REMOVES the key rather than writing "[]": opening every
    // folder again should leave no trace, and it keeps a browser's storage
    // from accumulating a row per file anyone ever scrolled past.
    if (ids.size === 0) localStorage.removeItem(keyFor(fileId))
    else localStorage.setItem(keyFor(fileId), JSON.stringify([...ids]))
  } catch {
    /* private mode — just won't persist */
  }
}

/** Toggle one folder, returning the new set. Pure, so the caller's state update
 *  stays a plain assignment and nothing mutates a set React is holding. */
export function toggleCollapsed(ids: ReadonlySet<string>, folderId: string): Set<string> {
  const next = new Set(ids)
  if (!next.delete(folderId)) next.add(folderId)
  return next
}

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

//
// AQU-1684: WHICH TRACKS THIS PERSON HAS HIDDEN is the same kind of state, kept
// the same way for the same reasons (Sam's decision): hiding a lane is where
// somebody is looking, so it is personal, per file and on this device — never
// synced, or one person tidying their timeline would empty a collaborator's.

const KEY_PREFIX = "aquilla:tlFoldersClosed:"
const HIDDEN_KEY_PREFIX = "aquilla:tlTracksHidden:"

/** The ids stored under `key`. Always a real Set — private mode, a cleared
 *  store and a corrupt value all read as "none", which is the state that hides
 *  no track from anybody. */
function loadIds(key: string): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === "string"))
  } catch {
    return new Set()
  }
}

function saveIds(key: string, ids: ReadonlySet<string>): void {
  try {
    // An empty set REMOVES the key rather than writing "[]": opening every
    // folder again should leave no trace, and it keeps a browser's storage
    // from accumulating a row per file anyone ever scrolled past.
    if (ids.size === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify([...ids]))
  } catch {
    /* private mode — just won't persist */
  }
}

/** The folder ids this person has closed on this file. */
export function loadCollapsedFolders(fileId: string | null | undefined): ReadonlySet<string> {
  return fileId ? loadIds(`${KEY_PREFIX}${fileId}`) : new Set()
}

export function saveCollapsedFolders(fileId: string | null | undefined, ids: ReadonlySet<string>): void {
  if (fileId) saveIds(`${KEY_PREFIX}${fileId}`, ids)
}

/** AQU-1684: the track ids this person has hidden on this file. */
export function loadHiddenTracks(fileId: string | null | undefined): ReadonlySet<string> {
  return fileId ? loadIds(`${HIDDEN_KEY_PREFIX}${fileId}`) : new Set()
}

export function saveHiddenTracks(fileId: string | null | undefined, ids: ReadonlySet<string>): void {
  if (fileId) saveIds(`${HIDDEN_KEY_PREFIX}${fileId}`, ids)
}

/** Toggle one folder, returning the new set. Pure, so the caller's state update
 *  stays a plain assignment and nothing mutates a set React is holding. */
export function toggleCollapsed(ids: ReadonlySet<string>, folderId: string): Set<string> {
  const next = new Set(ids)
  if (!next.delete(folderId)) next.add(folderId)
  return next
}

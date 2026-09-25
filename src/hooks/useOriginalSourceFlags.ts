import { useEffect, useMemo, useState } from "react"
import type { FileReference } from "@/lib/parsers/types"
import { fetchProjectFiles } from "@/lib/sync/cells-read"

/**
 * AQU-350: the flags come from a full, paginated listing of the project's
 * files, so a naive per-mount fetch re-lists the whole corpus every time the
 * Files dock panel is mounted — and the panel is unmounted on every dock-tab
 * switch. Two live instances of this hook (ProjectWorkspace + ExpandableFileList)
 * doubled that again. The listing is held in a module-level cache keyed by
 * project + file set so a remount reads it synchronously, concurrent callers
 * share one request, and the network read only happens when the entry is
 * missing or stale.
 */
const FRESH_MS = 30_000

interface CacheEntry {
  ids: Set<string>
  fetchedAt: number
  inFlight: Promise<void> | null
}

const cache = new Map<string, CacheEntry>()

/** Test seam — the cache is module state and outlives a component tree. */
export function __resetOriginalSourceFlagsCache(): void {
  cache.clear()
}

function isFresh(entry: CacheEntry | undefined): entry is CacheEntry {
  return entry != null && entry.inFlight == null && Date.now() - entry.fetchedAt < FRESH_MS
}

function load(
  cacheKey: string,
  projectId: string,
  fileId: string,
  getToken: (fileId: string) => Promise<string | null>,
): Promise<void> {
  const existing = cache.get(cacheKey)
  if (existing?.inFlight) return existing.inFlight

  const entry: CacheEntry = existing ?? { ids: new Set(), fetchedAt: 0, inFlight: null }
  entry.inFlight = getToken(fileId)
    .then((token) => (token ? fetchProjectFiles(projectId, token) : []))
    .then((rows) => {
      entry.ids = new Set(rows.filter((row) => row.hasOriginalSource).map((row) => row.fileId))
      entry.fetchedAt = Date.now()
    })
    .catch(() => {
      // Leave any previously cached ids in place; a failed refresh must not
      // drop the "Download original" affordance for files we already know about.
      cache.delete(cacheKey)
    })
    .finally(() => {
      entry.inFlight = null
    })
  cache.set(cacheKey, entry)
  return entry.inFlight
}

/**
 * File ids that have an original import blob (AQU-656). Merges optimistic
 * flags on FileReference (just-imported this session) with the files-list
 * `hasOriginalSource` field.
 */
export function useOriginalSourceFlags(
  projectId: string | undefined,
  files: FileReference[],
  getToken: (fileId: string) => Promise<string | null>,
): ReadonlySet<string> {
  const seeded = useMemo(
    () => new Set(files.filter((file) => file.hasOriginalSource).map((file) => file.id)),
    [files],
  )
  const fileKey = files.map((file) => file.id).join("\0")
  const cacheKey = `${projectId ?? ""}\n${fileKey}`
  const [fromServer, setFromServer] = useState<Set<string> | null>(
    () => cache.get(cacheKey)?.ids ?? null,
  )

  useEffect(() => {
    const fileId = fileKey.split("\0")[0]
    if (!projectId || !fileId) {
      setFromServer(new Set())
      return
    }
    const cached = cache.get(cacheKey)
    // Serve what we already have before deciding whether to hit the network,
    // so a dock-tab switch repaints from cache with no loading gap.
    setFromServer(cached?.ids ?? null)
    if (isFresh(cached)) return

    let cancelled = false
    void load(cacheKey, projectId, fileId, getToken).then(() => {
      if (cancelled) return
      setFromServer(cache.get(cacheKey)?.ids ?? null)
    })
    return () => { cancelled = true }
  }, [cacheKey, projectId, fileKey, getToken])

  return useMemo(() => {
    const ids = new Set(seeded)
    if (fromServer) for (const id of fromServer) ids.add(id)
    return ids
  }, [seeded, fromServer])
}

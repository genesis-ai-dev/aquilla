import { useEffect, useMemo, useState } from "react"
import type { FileReference } from "@/lib/parsers/types"
import { fetchProjectFiles } from "@/lib/sync/cells-read"

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
  const [fromServer, setFromServer] = useState<Set<string> | null>(null)
  const fileKey = files.map((file) => file.id).join("\0")

  useEffect(() => {
    const fileId = fileKey.split("\0")[0]
    if (!projectId || !fileId) {
      setFromServer(new Set())
      return
    }
    let cancelled = false
    void getToken(fileId)
      .then((token) => (token ? fetchProjectFiles(projectId, token) : []))
      .then((rows) => {
        if (cancelled) return
        setFromServer(new Set(
          rows.filter((row) => row.hasOriginalSource).map((row) => row.fileId),
        ))
      })
      .catch(() => {
        if (!cancelled) setFromServer(null)
      })
    return () => { cancelled = true }
  }, [projectId, fileKey, getToken])

  return useMemo(() => {
    const ids = new Set(seeded)
    if (fromServer) for (const id of fromServer) ids.add(id)
    return ids
  }, [seeded, fromServer])
}

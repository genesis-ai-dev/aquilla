import { useEffect, useMemo, useState } from "react"
import { getCellAudioStreamUrl, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import type { FrontierSession } from "@/lib/frontier/types"

interface Args {
  src: string
  projectId?: string
  fileId: string
  retryKey: number
  session?: Pick<FrontierSession, "jwt" | "username"> | null
}

/** Resolve stable clip references only for the current file and identity. */
export function useMediaPictureUrl(args: Args): string | null {
  const { src, projectId, fileId, retryKey, session } = args
  const pointer = parseFrontierAudioUrl(src)
  const scope = useMemo(() => ({
    src, projectId, fileId, retryKey,
    jwt: session?.jwt, username: session?.username,
  }), [src, projectId, fileId, retryKey, session?.jwt, session?.username])
  const [resolved, setResolved] = useState<{
    scope: typeof scope
    url: string | null
  } | null>(null)

  useEffect(() => {
    const clip = parseFrontierAudioUrl(scope.src)
    if (!clip || !scope.projectId || !scope.jwt) return
    let live = true
    const getSyncToken = audioSyncTokenFetcherForSession({
      jwt: scope.jwt!, username: scope.username!,
    } as FrontierSession)
    void getCellAudioStreamUrl({
      projectId: scope.projectId,
      fileId: scope.fileId,
      ...clip,
      getSyncToken,
    }).then((url) => {
      if (live) setResolved({ scope, url })
    }).catch(() => {
      if (live) setResolved({ scope, url: null })
    })
    return () => { live = false }
  }, [scope])

  if (!pointer) return src.startsWith("frontier-audio:") ? null : src
  if (!session?.jwt || !projectId) return null
  return resolved?.scope === scope ? resolved.url : null
}

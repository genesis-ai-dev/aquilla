// Live ElevenLabs account for the connected key (AQU-2299): tier and character
// quota for the connected bar, `canClone` for the Clone tab. Re-reads when the
// key changes (connect / disconnect anywhere on this device).
import { useCallback, useEffect, useState } from "react"
import { useElevenLabsKey } from "@/lib/audio/elevenlabs/key"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { fetchElevenLabsAccount, type ElevenLabsAccount } from "@/lib/sync/elevenlabs"
import type { FrontierSession } from "@/lib/frontier/types"

export type ElevenLabsAccountState =
  | { status: "disconnected" }
  | { status: "loading" }
  | { status: "ready"; account: ElevenLabsAccount }
  | { status: "error"; message: string }

export interface ElevenLabsAccountScope {
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
}

export function useElevenLabsAccount(scope: ElevenLabsAccountScope): {
  key: string | undefined
  state: ElevenLabsAccountState
  refresh: () => void
} {
  const key = useElevenLabsKey()
  const { projectId, fileId, session } = scope
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  const [result, setResult] = useState<{ id: string; state: ElevenLabsAccountState } | null>(null)
  // The lookup this render wants; a result for any other one reads as loading.
  const requestId = key && projectId && session
    ? `${key}\u0000${projectId}\u0000${fileId ?? ""}\u0000${session.username}\u0000${nonce}`
    : null

  useEffect(() => {
    if (!requestId || !key || !projectId || !session) return
    let live = true
    fetchElevenLabsAccount({ projectId, fileId, apiKey: key }, audioSyncTokenFetcherForSession(session))
      .then((account) => { if (live) setResult({ id: requestId, state: { status: "ready", account } }) })
      .catch((e: unknown) => {
        if (live) setResult({ id: requestId, state: { status: "error", message: e instanceof Error ? e.message : String(e) } })
      })
    return () => { live = false }
  }, [requestId, key, projectId, fileId, session])

  const state: ElevenLabsAccountState = !key
    ? { status: "disconnected" }
    : !requestId
      ? { status: "error", message: "" }
      : result?.id === requestId ? result.state : { status: "loading" }

  return { key, state, refresh }
}

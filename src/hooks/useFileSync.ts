// File-level sync hook backed by the codex sync-worker (y-partyserver DO + R2).
// Mirrors useSync's shape so callers only change the import and input keys.

import { useEffect, useState, useMemo, useRef } from "react"
import * as Y from "yjs"
import type YProvider from "y-partyserver/provider"
import {
  createFileSyncProvider,
  destroyFileSyncProvider,
  type FileSyncProviderHandle,
} from "@/lib/sync/partyserver-provider"
import { peerColor } from "@/lib/sync/webrtc-provider"
import { makeSyncTokenFetcher } from "@/lib/sync/sync-token"
import type { PeerState } from "@/hooks/useSync"
import type { FrontierSession } from "@/lib/frontier/types"
import type { SyncStatus } from "@/components/SyncStatusIndicator"

interface UseFileSyncOptions {
  doc: Y.Doc | null
  projectId: string | null
  fileId: string | null
  username: string
  enabled: boolean
  /** Active Frontier session. When null, the provider connects with no auth
   *  token — fine in dev mode, rejected in prod (editor keeps working via
   *  IndexedDB). */
  session: FrontierSession | null
  /** Human-readable project name — forwarded to /sync-token so the server can
   *  auto-register the project row on first use with something meaningful. */
  projectName?: string | null
  /** GitLab project ID when the project is GitLab-backed; enables the
   *  GitLab-permission fallback for other users later. */
  gitlabProjectId?: number | null
}

export function useFileSync(options: UseFileSyncOptions): {
  peers: PeerState[]
  connected: boolean
  provider: YProvider | null
  status: SyncStatus
} {
  const { doc, projectId, fileId, username, enabled, session, projectName, gitlabProjectId } = options
  const [peers, setPeers] = useState<PeerState[]>([])
  const [connected, setConnected] = useState(false)
  const [provider, setProviderState] = useState<YProvider | null>(null)

  const handleRef = useMemo(() => ({ current: null as FileSyncProviderHandle | null }), [])

  // Stash the current jwt in a ref so the token-fetcher closure always reads
  // the latest session without tearing down the provider on session swap.
  const jwtRef = useRef<string | null>(session?.jwt ?? null)
  useEffect(() => {
    jwtRef.current = session?.jwt ?? null
  }, [session])

  useEffect(() => {
    if (!enabled || !doc || !projectId || !fileId) {
      setPeers([])
      setConnected(false)
      setProviderState(null)
      return
    }

    const getToken = makeSyncTokenFetcher(() => jwtRef.current, projectId, fileId, {
      projectName: projectName ?? undefined,
      gitlabProjectId: gitlabProjectId ?? undefined,
    })
    const handle = createFileSyncProvider(doc, projectId, fileId, getToken)
    handleRef.current = handle
    const { provider } = handle
    setProviderState(provider)

    const selfState: PeerState = {
      peerId: String(provider.awareness.clientID),
      username,
      color: peerColor(String(provider.awareness.clientID)),
      currentFileId: fileId,
    }
    provider.awareness.setLocalState(selfState)

    function updatePeers() {
      const states: PeerState[] = []
      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId === provider.awareness.clientID) return
        if (!state) return
        states.push({
          peerId: String(clientId),
          username: String(state.username || "anonymous"),
          color: (state.color as string) || peerColor(String(clientId)),
          currentFileId: state.currentFileId as string | undefined,
        })
      })
      setPeers(states)
    }

    function updateConnected() {
      const anyProvider = provider as unknown as { wsconnected?: boolean }
      setConnected(Boolean(anyProvider.wsconnected))
    }

    provider.awareness.on("change", updatePeers)
    provider.on("status", updateConnected)
    provider.on("sync", updateConnected)
    updatePeers()
    updateConnected()

    return () => {
      provider.awareness.off("change", updatePeers)
      provider.off("status", updateConnected)
      provider.off("sync", updateConnected)
      destroyFileSyncProvider(handle)
      handleRef.current = null
      setProviderState(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, projectId, fileId, enabled])

  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    const { provider } = handle
    const current = provider.awareness.getLocalState() || {}
    provider.awareness.setLocalState({
      ...current,
      username,
      currentFileId: fileId,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, fileId])

  // Status derivation:
  //   disabled   — hook not running (no session, no project/file, or disabled)
  //   connecting — provider exists but WS hasn't completed the handshake yet;
  //                doubles as the "reconnecting" state since YProvider
  //                automatically backs off on failure
  //   live       — WS connected AND server acked sync
  const status: SyncStatus = !provider
    ? "disabled"
    : connected
      ? "live"
      : "connecting"

  return { peers, connected, provider, status }
}

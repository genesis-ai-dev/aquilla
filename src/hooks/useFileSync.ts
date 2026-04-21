// File-level sync hook backed by the codex sync-worker (y-partyserver DO + R2).
// Mirrors useSync's shape so callers only change the import and input keys.

import { useEffect, useState, useMemo } from "react"
import * as Y from "yjs"
import type YProvider from "y-partyserver/provider"
import {
  createFileSyncProvider,
  destroyFileSyncProvider,
  type FileSyncProviderHandle,
} from "@/lib/sync/partyserver-provider"
import { peerColor } from "@/lib/sync/webrtc-provider"
import type { PeerState } from "@/hooks/useSync"

interface UseFileSyncOptions {
  doc: Y.Doc | null
  projectId: string | null
  fileId: string | null
  username: string
  enabled: boolean
}

export function useFileSync(options: UseFileSyncOptions): {
  peers: PeerState[]
  connected: boolean
  provider: YProvider | null
} {
  const { doc, projectId, fileId, username, enabled } = options
  const [peers, setPeers] = useState<PeerState[]>([])
  const [connected, setConnected] = useState(false)
  const [provider, setProviderState] = useState<YProvider | null>(null)

  const handleRef = useMemo(() => ({ current: null as FileSyncProviderHandle | null }), [])

  useEffect(() => {
    if (!enabled || !doc || !projectId || !fileId) {
      setPeers([])
      setConnected(false)
      setProviderState(null)
      return
    }

    const handle = createFileSyncProvider(doc, projectId, fileId)
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

  return { peers, connected, provider }
}

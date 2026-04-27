import { useEffect, useState, useMemo } from "react"
import * as Y from "yjs"
import type { WebsocketProvider } from "y-websocket"
import { createSyncProvider, destroySyncProvider, peerColor, type SyncProviderHandle } from "@/lib/sync/signaling-provider"
import { displayNameFor } from "@/lib/sync/anonymous-name"

export interface PeerState {
  peerId: string  // ephemeral client ID from y-webrtc awareness
  username: string
  color: string
  currentFileId?: string
}

interface UseSyncOptions {
  doc: Y.Doc | null
  roomName: string | null          // null = disabled
  username: string
  currentFileId?: string
  enabled: boolean
}

export function useSync(options: UseSyncOptions): {
  peers: PeerState[]
  connected: boolean
  provider: WebsocketProvider | null
} {
  const { doc, roomName, username, currentFileId, enabled } = options
  const [peers, setPeers] = useState<PeerState[]>([])
  const [connected, setConnected] = useState(false)
  const [provider, setProviderState] = useState<WebsocketProvider | null>(null)

  const handleRef = useMemo(() => ({ current: null as SyncProviderHandle | null }), [])

  useEffect(() => {
    if (!enabled || !doc || !roomName) {
      setPeers([])
      setConnected(false)
      setProviderState(null)
      return
    }

    const handle = createSyncProvider(doc, roomName)
    handleRef.current = handle
    const { provider } = handle
    setProviderState(provider)

    // Publish our own awareness state. Unauthenticated peers get a stable
    // friendly name derived from their clientID instead of a placeholder.
    const selfClientId = String(provider.awareness.clientID)
    const selfState: PeerState = {
      peerId: selfClientId,
      username: displayNameFor(username, selfClientId),
      color: peerColor(selfClientId),
      currentFileId,
    }
    provider.awareness.setLocalState(selfState)

    function updatePeers() {
      const states: PeerState[] = []
      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId === provider.awareness.clientID) return  // skip self
        if (!state) return
        const peerClientId = String(clientId)
        states.push({
          peerId: peerClientId,
          username: displayNameFor(state.username as string | undefined, peerClientId),
          color: state.color as string || peerColor(peerClientId),
          currentFileId: state.currentFileId as string | undefined,
        })
      })
      setPeers(states)
    }

    function updateConnected() {
      // y-websocket uses `wsconnected`; fall back to `connected` for other providers.
      const anyProvider = provider as unknown as { wsconnected?: boolean; connected?: boolean }
      setConnected(Boolean(anyProvider.wsconnected ?? anyProvider.connected))
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
      destroySyncProvider(handle)
      handleRef.current = null
      setProviderState(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, roomName, enabled])

  // Update local awareness when current file or username changes
  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    const { provider } = handle
    const current = provider.awareness.getLocalState() || {}
    const selfClientId = String(provider.awareness.clientID)
    provider.awareness.setLocalState({
      ...current,
      username: displayNameFor(username, selfClientId),
      currentFileId,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, currentFileId])

  return { peers, connected, provider }
}

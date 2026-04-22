import { WebsocketProvider } from "y-websocket"
import * as Y from "yjs"

// Cloudflare Durable Object relay. Each unique roomName is routed to its own
// DO instance, which acts as a pub/sub for y-websocket protocol binary messages.
// See signaling/src/index.ts for the server implementation.
export const SIGNALING_URL = "wss://codex-signaling.ryderwishart.workers.dev"

export interface SyncProviderHandle {
  provider: WebsocketProvider
  roomName: string
}

export function createSyncProvider(doc: Y.Doc, roomName: string): SyncProviderHandle {
  // y-websocket connects to `${serverUrl}/${roomName}` and expects the server
  // to broadcast binary sync messages to other peers.
  const provider = new WebsocketProvider(SIGNALING_URL, roomName, doc, {
    // Auto-connect on creation
    connect: true,
  })

  return { provider, roomName }
}

export function destroySyncProvider(handle: SyncProviderHandle): void {
  try {
    handle.provider.destroy()
  } catch (err) {
    console.warn("Error destroying sync provider:", err)
  }
}

// Generate a deterministic color hex string from a peerId for avatar tinting
export function peerColor(peerId: string): string {
  let hash = 0
  for (let i = 0; i < peerId.length; i++) {
    hash = (hash << 5) - hash + peerId.charCodeAt(i)
    hash |= 0
  }
  const colors = [
    "#3b82f6", "#ef4444", "#22c55e", "#a855f7", "#f97316",
    "#14b8a6", "#eab308", "#ec4899", "#6366f1", "#84cc16",
  ]
  return colors[Math.abs(hash) % colors.length]
}

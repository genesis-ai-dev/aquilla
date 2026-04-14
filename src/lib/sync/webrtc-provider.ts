import { WebrtcProvider } from "y-webrtc"
import * as Y from "yjs"

// Our own Cloudflare Durable Object signaling server.
// The previous y-webrtc public servers (Heroku-hosted and y-webrtc-eu.fly.dev)
// are no longer operational. This server is in `signaling/` and deployed via
// `wrangler deploy` from that directory.
const DEFAULT_SIGNALING = [
  "wss://codex-signaling.ryderwishart.workers.dev",
]

export interface SyncProviderHandle {
  provider: WebrtcProvider
  roomName: string
}

export function createSyncProvider(doc: Y.Doc, roomName: string): SyncProviderHandle {
  const provider = new WebrtcProvider(roomName, doc, {
    signaling: DEFAULT_SIGNALING,
    password: null,  // PIN is enforced at the app layer via handshake, not here
    peerOpts: {
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          // Free TURN fallback for symmetric NAT cases
          {
            urls: [
              "turn:openrelay.metered.ca:80",
              "turn:openrelay.metered.ca:443",
              "turn:openrelay.metered.ca:443?transport=tcp",
            ],
            username: "openrelayproject",
            credential: "openrelayproject",
          },
        ],
      },
    },
  } as unknown as ConstructorParameters<typeof WebrtcProvider>[2])

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
  // Map to a palette of pleasant colors
  const colors = [
    "#3b82f6", "#ef4444", "#22c55e", "#a855f7", "#f97316",
    "#14b8a6", "#eab308", "#ec4899", "#6366f1", "#84cc16",
  ]
  return colors[Math.abs(hash) % colors.length]
}

/**
 * Cloudflare Worker + Durable Object that relays Yjs sync messages via WebSocket.
 *
 * URL scheme: wss://<worker>/{roomName}
 * Each unique roomName is routed to its own Durable Object instance.
 *
 * The DO simply broadcasts every binary message it receives to all other
 * connected peers in the same room. The y-websocket protocol (sync + awareness)
 * is opaque to us — we're just a message relay. Late joiners sync with peers
 * already in the room via the standard y-websocket sync handshake.
 *
 * No server-side Y.Doc state for MVP. Data persists in each client's IndexedDB.
 * If all peers disconnect, the room is effectively empty until someone rejoins.
 */

export interface Env {
  ROOM: DurableObjectNamespace
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    // The pathname (minus leading slash) is the room name.
    const roomName = decodeURIComponent(url.pathname.slice(1))

    if (!roomName) {
      return new Response(
        "Codex Yjs relay. Connect via WebSocket to /{roomName}",
        { status: 426, headers: { "Content-Type": "text/plain" } }
      )
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response(`Expected WebSocket for room "${roomName}"`, {
        status: 426,
        headers: { "Content-Type": "text/plain" },
      })
    }

    const id = env.ROOM.idFromName(roomName)
    const stub = env.ROOM.get(id)
    return stub.fetch(request)
  },
}

export class CodexRoom {
  private state: DurableObjectState
  private connections: Set<WebSocket> = new Set()

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.accept()
    this.connections.add(server)
    console.log(`[connect] room sockets: ${this.connections.size}`)

    server.addEventListener("message", (event) => {
      // Broadcast to all other peers. Binary messages come through as
      // ArrayBuffer; string messages come through as string.
      let broadcast = 0
      for (const peer of this.connections) {
        if (peer === server) continue
        if (peer.readyState !== 1) continue
        try {
          // event.data is ArrayBuffer or string — forward as-is.
          peer.send(event.data)
          broadcast += 1
        } catch (err) {
          console.log(`[send-error] ${String(err)}`)
        }
      }
      const size =
        typeof event.data === "string"
          ? event.data.length
          : (event.data as ArrayBuffer).byteLength
      console.log(`[msg] size=${size} relayed=${broadcast}`)
    })

    const cleanup = () => {
      this.connections.delete(server)
      console.log(`[disconnect] room sockets: ${this.connections.size}`)
    }
    server.addEventListener("close", cleanup)
    server.addEventListener("error", cleanup)

    return new Response(null, { status: 101, webSocket: client })
  }
}

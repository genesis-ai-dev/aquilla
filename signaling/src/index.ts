/**
 * Cloudflare Worker + Durable Object that relays Yjs sync messages via WebSocket.
 *
 * Uses the Hibernatable WebSocket API so the DO goes dormant between messages.
 * Standard WebSockets bill for the entire connection duration (even idle);
 * hibernatable ones bill only when the DO wakes to handle a message — cutting
 * daily duration by 99%+ for mostly-idle translation sessions.
 *
 * URL scheme: wss://<worker>/{roomName}
 * Each unique roomName is routed to its own Durable Object instance.
 *
 * Idle timeout: if no message is relayed for IDLE_TIMEOUT_MS, the DO closes
 * all connections. Clients (y-websocket) automatically reconnect, which wakes
 * a fresh DO instance on demand.
 */

const IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

export interface Env {
  ROOM: DurableObjectNamespace
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const roomName = decodeURIComponent(url.pathname.slice(1))

    if (!roomName) {
      return new Response(
        "Codex Yjs relay. Connect via WebSocket to /{roomName}",
        { status: 426, headers: { "Content-Type": "text/plain" } },
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
  private ctx: DurableObjectState

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx
  }

  async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    // Hibernatable accept — the DO can sleep between messages. CF only bills
    // wall-time when the DO is actively running a handler.
    this.ctx.acceptWebSocket(server)
    this.resetIdleAlarm()

    const count = this.ctx.getWebSockets().length
    console.log(`[connect] room sockets: ${count}`)

    return new Response(null, { status: 101, webSocket: client })
  }

  // --- Hibernatable WebSocket handlers ------------------------------------
  // These run when the DO wakes from hibernation to process a single event.

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    this.resetIdleAlarm()
    const peers = this.ctx.getWebSockets()
    let broadcast = 0
    for (const peer of peers) {
      if (peer === ws) continue
      try {
        peer.send(message)
        broadcast++
      } catch {
        // Peer already gone — close handler will clean it up.
      }
    }
    const size = typeof message === "string" ? message.length : message.byteLength
    console.log(`[msg] size=${size} relayed=${broadcast}`)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    ws.close(code, reason)
    const remaining = this.ctx.getWebSockets().length
    console.log(`[disconnect] code=${code} clean=${wasClean} remaining=${remaining}`)
    if (remaining === 0) {
      // No point keeping the alarm; DO will evict naturally.
      await this.ctx.storage.deleteAlarm()
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.log(`[ws-error] ${String(error)}`)
    ws.close(1011, "WebSocket error")
  }

  // --- Idle timeout via alarm ---------------------------------------------

  private async resetIdleAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS)
  }

  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets()
    if (sockets.length === 0) return
    console.log(`[idle-timeout] closing ${sockets.length} idle socket(s)`)
    for (const ws of sockets) {
      try {
        ws.close(1000, "Idle timeout — reconnect when needed")
      } catch {
        // Already closed.
      }
    }
  }
}

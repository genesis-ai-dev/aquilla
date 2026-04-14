/**
 * Cloudflare Worker + Durable Object implementing the y-webrtc signaling protocol.
 *
 * y-webrtc uses a simple topic-based pub/sub over WebSocket:
 *   - { type: "subscribe", topics: string[] }    — join topics (rooms)
 *   - { type: "unsubscribe", topics: string[] }  — leave topics
 *   - { type: "publish", topic: string, ... }    — broadcast to all subscribers of topic
 *   - { type: "ping" } → server responds { type: "pong" }
 *
 * The server just relays "publish" messages to other subscribers of the same topic.
 * It never reads or stores any WebRTC payload content — that flows peer-to-peer.
 */

export interface Env {
  SIGNALING: DurableObjectNamespace
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response(
        "y-webrtc signaling server. Connect via WebSocket.",
        { status: 426, headers: { "Content-Type": "text/plain" } }
      )
    }
    // Single global signaling DO. Cloudflare keeps it warm based on traffic.
    // For scale, we could shard by topic prefix later.
    const id = env.SIGNALING.idFromName("global")
    const stub = env.SIGNALING.get(id)
    return stub.fetch(request)
  },
}

interface PublishMessage {
  type: "publish"
  topic: string
  [key: string]: unknown
}

interface TopicMessage {
  type: "subscribe" | "unsubscribe"
  topics: string[]
}

type IncomingMessage = PublishMessage | TopicMessage | { type: "ping" }

export class SignalingRoom {
  private state: DurableObjectState
  // topic -> Set of WebSockets subscribed to it
  private subscriptions: Map<string, Set<WebSocket>> = new Map()
  // WebSocket -> Set of topics it's subscribed to
  private socketTopics: Map<WebSocket, Set<string>> = new Map()

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.accept()

    this.socketTopics.set(server, new Set())

    server.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return
      let data: IncomingMessage
      try {
        data = JSON.parse(event.data)
      } catch {
        return
      }
      this.handleMessage(server, data)
    })

    const cleanup = () => this.handleClose(server)
    server.addEventListener("close", cleanup)
    server.addEventListener("error", cleanup)

    return new Response(null, { status: 101, webSocket: client })
  }

  private handleMessage(ws: WebSocket, data: IncomingMessage) {
    if (data.type === "subscribe") {
      for (const topic of data.topics || []) {
        let subs = this.subscriptions.get(topic)
        if (!subs) {
          subs = new Set()
          this.subscriptions.set(topic, subs)
        }
        subs.add(ws)
        this.socketTopics.get(ws)?.add(topic)
      }
    } else if (data.type === "unsubscribe") {
      for (const topic of data.topics || []) {
        this.subscriptions.get(topic)?.delete(ws)
        this.socketTopics.get(ws)?.delete(topic)
      }
    } else if (data.type === "publish") {
      const topic = data.topic
      if (!topic) return
      const subs = this.subscriptions.get(topic)
      if (!subs) return
      const message = JSON.stringify(data)
      for (const sub of subs) {
        if (sub !== ws && sub.readyState === WebSocket.READY_STATE_OPEN) {
          try {
            sub.send(message)
          } catch {
            // ignore send errors; cleanup happens on close event
          }
        }
      }
    } else if (data.type === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong" }))
      } catch {
        // ignore
      }
    }
  }

  private handleClose(ws: WebSocket) {
    const topics = this.socketTopics.get(ws)
    if (topics) {
      for (const topic of topics) {
        const subs = this.subscriptions.get(topic)
        if (subs) {
          subs.delete(ws)
          if (subs.size === 0) this.subscriptions.delete(topic)
        }
      }
    }
    this.socketTopics.delete(ws)
  }
}

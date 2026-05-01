import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

export interface MockLLMRequest {
  url: string
  method: string
  body: unknown
  timestamp: number
}

/**
 * A minimal OpenAI-compatible mock LLM server for e2e tests.
 * Responds to POST /v1/chat/completions and GET /v1/models.
 */
export class MockLLMServer {
  private server: ReturnType<typeof createServer> | null = null
  private _nextResponse = "Traducción de prueba"
  private _requests: MockLLMRequest[] = []
  private _port = 0

  get port() { return this._port }
  get baseUrl() { return `http://127.0.0.1:${this._port}` }
  get requests() { return this._requests }

  setNextResponse(text: string) { this._nextResponse = text }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handle(req, res))
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address()
        this._port = typeof addr === "object" ? addr!.port : 0
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve())
      else resolve()
    })
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }

    if (req.method === "GET" && req.url?.includes("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        data: [{ id: "mock-model", object: "model", owned_by: "test" }],
      }))
      return
    }

    if (req.method === "POST" && req.url?.includes("/chat/completions")) {
      let body = ""
      req.on("data", (c) => { body += c })
      req.on("end", () => {
        let parsed: unknown = null
        try { parsed = JSON.parse(body) } catch {}
        this._requests.push({
          url: req.url!,
          method: req.method!,
          body: parsed,
          timestamp: Date.now(),
        })
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          id: "mock-" + Date.now(),
          object: "chat.completion",
          choices: [{
            index: 0,
            message: { role: "assistant", content: this._nextResponse },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }))
      })
      return
    }

    res.writeHead(404)
    res.end("Not found")
  }
}

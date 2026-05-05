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
        let parsed: { stream?: boolean } | null = null
        try { parsed = JSON.parse(body) as { stream?: boolean } } catch {}
        this._requests.push({
          url: req.url!,
          method: req.method!,
          body: parsed,
          timestamp: Date.now(),
        })

        const id = "mock-" + Date.now()

        // Custom-provider clients (the AI completion path under test) always
        // request stream:true. Honor it with proper OpenAI-compatible SSE so
        // the consumeStream() reader extracts delta.content; without this,
        // the client treats the JSON body as SSE and finds no `data:` lines.
        if (parsed?.stream === true) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          })
          const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
          res.write(frame({
            id, object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant", content: this._nextResponse }, finish_reason: null }],
          }))
          res.write(frame({
            id, object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }))
          res.write("data: [DONE]\n\n")
          res.end()
          return
        }

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          id,
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

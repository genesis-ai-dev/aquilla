import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Page } from "@playwright/test"

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
// Matches `<c id="CELLID">TEXT</c>` tags embedded in the OUTGOING request
// (buildParagraphPrompt encodes the live paragraph's draftable cells this
// way — see src/lib/completion/paragraph-protocol.ts). Mirrors the parser's
// own TAG_RE so this generic echo stays in lockstep with the real protocol.
const REQUEST_TAG_RE = /<c\s+id="([^"]+)">([\s\S]*?)<\/c>/g
const REQUEST_BATCH_TAG_RE = /<v(\d+)>([\s\S]*?)<\/v\1>/g

interface MockChatBody {
  stream?: boolean
  messages?: { content?: string }[]
}

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
        let parsed: MockChatBody | null = null
        try { parsed = JSON.parse(body) as MockChatBody } catch {}
        this._requests.push({
          url: req.url!,
          method: req.method!,
          body: parsed,
          timestamp: Date.now(),
        })

        const id = "mock-" + Date.now()

        // Paragraph-draft requests (completeParagraph) encode the live
        // paragraph's cells as `<c id="CELLID">source</c>` tags in the
        // outgoing prompt (D11 protocol). Echo them back tagged the same
        // way so parseParagraphResponse can reconcile every expected id —
        // a static canned string can never do this since cell ids are
        // minted at import time. Falls back to `_nextResponse` for
        // non-paragraph (single-cell) completion requests, which don't use
        // the tag protocol at all.
        const combinedContent = (parsed?.messages ?? [])
          .map((m) => m.content ?? "")
          .join("\n")
        const requestTags: { id: string; text: string }[] = []
        REQUEST_TAG_RE.lastIndex = 0
        let tagMatch: RegExpExecArray | null
        while ((tagMatch = REQUEST_TAG_RE.exec(combinedContent)) !== null) {
          requestTags.push({ id: tagMatch[1], text: tagMatch[2] })
        }
        // Batch completion puts the live package in the final user message.
        // Parse only that message so any numbered few-shot examples earlier
        // in the prompt cannot be mistaken for cells in the requested batch.
        const liveBatchContent = parsed?.messages?.at(-1)?.content ?? ""
        const batchTags: { index: string; text: string }[] = []
        REQUEST_BATCH_TAG_RE.lastIndex = 0
        let batchMatch: RegExpExecArray | null
        while ((batchMatch = REQUEST_BATCH_TAG_RE.exec(liveBatchContent)) !== null) {
          batchTags.push({ index: batchMatch[1], text: batchMatch[2] })
        }
        const responseText = requestTags.length
          ? requestTags.map(({ id: cellId, text }) => `<c id="${cellId}">[DRAFT] ${text}</c>`).join("\n")
          : batchTags.length
            ? batchTags.map(({ index, text }) => `<v${index}>[DRAFT] ${text}</v${index}>`).join("\n")
          : this._nextResponse

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
            choices: [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null }],
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
            message: { role: "assistant", content: responseText },
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

/**
 * Point a signed-in user's per-device AI provider override at an
 * OpenAI-compatible endpoint (usually a MockLLMServer / the stack-level mock
 * behind VITE_LLM_BASE_URL).
 *
 * The app reads the override through the account-scoped localStorage key
 * minted by ownerScopedLocalStorageKey() (src/lib/frontier/client-local-storage.ts).
 * The raw legacy `aquilla:userProviderOverride` key is claimed once during
 * the first owner resolution on a device and ignored on every later boot, so
 * specs must write the owner-scoped key directly. Reload the page afterwards
 * so React state (useCompletion's isConfigured) picks the override up.
 */
export async function applyUserProviderOverride(
  page: Page,
  username: string,
  endpoint: string,
  override: { model?: string; apiKey?: string } = {},
): Promise<void> {
  await page.evaluate(({ username, endpoint, model, apiKey }) => {
    const key = `owner:account:${encodeURIComponent(username)}:aquilla:userProviderOverride`
    localStorage.setItem(key, JSON.stringify({ endpoint, model, apiKey }))
  }, {
    username,
    endpoint,
    model: override.model ?? "mock-model",
    apiKey: override.apiKey ?? "",
  })
}

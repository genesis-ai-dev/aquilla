// upstream.ts — read one model turn from OpenRouter, streaming or not.
//
// The agent loop requests `stream: true` so prose reaches the user token by
// token (design 2026-07-02 §2.2), but every scripted mock in this repo
// (agent-route tests, scripts/mock-openrouter.ts) answers plain JSON. This
// reader dispatches on the response Content-Type: SSE → assemble the message
// from deltas (forwarding content fragments as they arrive), JSON → the v1
// single-shot parse (forwarding the whole content once). Either way the
// caller gets the same shape: a complete assistant message + usage totals.

export interface ToolCall {
  id: string
  type: string
  function: { name: string; arguments: string }
}

export interface UpstreamMessage {
  role: string
  content: string | null
  tool_calls?: ToolCall[]
}

export interface UpstreamUsage {
  prompt_tokens?: number
  completion_tokens?: number
  cost?: number
}

export interface UpstreamTurn {
  message: UpstreamMessage
  usage?: UpstreamUsage
}

interface JsonBody {
  choices?: { message?: UpstreamMessage }[]
  usage?: UpstreamUsage
  error?: { message?: string }
}

/** One streamed chunk: OpenAI chat.completion.chunk shape (the parts we use). */
interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null
      tool_calls?: {
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
  }[]
  usage?: UpstreamUsage | null
  error?: { message?: string }
}

/**
 * Read one model turn from an OK upstream response. `onContentDelta` fires for
 * each prose fragment (once with the full text in JSON mode) — the returned
 * message still carries the complete content for the conversation transcript.
 * Throws on malformed bodies and mid-stream `error` chunks.
 */
export async function readModelTurn(
  res: Response,
  onContentDelta: (text: string) => void,
): Promise<UpstreamTurn> {
  const contentType = res.headers.get("Content-Type") ?? ""
  if (!contentType.includes("text/event-stream")) {
    const data = (await res.json()) as JsonBody
    if (data.error?.message) throw new Error(`openrouter_error: ${data.error.message}`)
    const message = data.choices?.[0]?.message
    if (!message) throw new Error("openrouter returned no message")
    if (message.content) onContentDelta(message.content)
    return { message, usage: data.usage }
  }

  if (!res.body) throw new Error("openrouter stream had no body")

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let content = ""
  let sawChunk = false
  let usage: UpstreamUsage | undefined
  // tool_call deltas arrive as fragments keyed by index; arguments concatenate.
  const toolCalls: ToolCall[] = []

  const processChunk = (chunk: StreamChunk): void => {
    sawChunk = true
    if (chunk.error?.message) throw new Error(`openrouter_error: ${chunk.error.message}`)
    if (chunk.usage) usage = chunk.usage
    const delta = chunk.choices?.[0]?.delta
    if (!delta) return
    if (delta.content) {
      content += delta.content
      onContentDelta(delta.content)
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0
      while (toolCalls.length <= idx) {
        toolCalls.push({ id: "", type: "function", function: { name: "", arguments: "" } })
      }
      const slot = toolCalls[idx]
      if (tc.id) slot.id = tc.id
      if (tc.type) slot.type = tc.type
      if (tc.function?.name) slot.function.name += tc.function.name
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
    }
  }

  const processLine = (line: string): void => {
    if (!line.startsWith("data:")) return
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") return
    let chunk: StreamChunk
    try {
      chunk = JSON.parse(payload) as StreamChunk
    } catch {
      // OpenRouter interleaves ": comment" keep-alives; a torn frame here
      // means OUR line buffering broke — surface it rather than silently
      // dropping a tool-call fragment (which would corrupt the arguments).
      throw new Error(`openrouter stream sent an unparseable frame: ${payload.slice(0, 120)}`)
    }
    processChunk(chunk)
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, "")
        buffer = buffer.slice(newlineIdx + 1)
        processLine(line)
      }
    }
    if (buffer.trim()) processLine(buffer.trim())
  } finally {
    reader.cancel().catch(() => {
      /* already closed */
    })
  }

  if (!sawChunk) throw new Error("openrouter returned no message")

  const message: UpstreamMessage = {
    role: "assistant",
    content: content || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
  return { message, usage }
}

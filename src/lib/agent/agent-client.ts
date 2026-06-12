/**
 * agent-client.ts — POST /api/v1/ai/agent/run + SSE frame parsing.
 *
 * Wire contract: src/lib/agent/protocol.ts (mirrors the implementation plan
 * doc). The agent endpoint lives on the SAME auth-worker origin as
 * /api/v1/chat/completions, so the URL is derived from FRONTIER_CHAT_URL
 * (completion-service.ts owns the VITE_CHAT_BASE / VITE_FRONTIER_BASE
 * resolution) and auth is the same Bearer JWT the chat path attaches.
 *
 * Frame parsing mirrors completion-service's consumeStream: SSE events span
 * arbitrary reader.read() boundaries, so lines are buffered across reads —
 * a `data:` frame split mid-JSON must reassemble before JSON.parse.
 */

import { FRONTIER_CHAT_URL } from "@/lib/completion/completion-service"
import type { AgentFrame, AgentRunRequest } from "./protocol"

export const AGENT_RUN_URL = FRONTIER_CHAT_URL.replace(
  /\/api\/v1\/chat\/completions$/,
  "/api/v1/ai/agent/run",
)

export interface RunAgentOptions {
  request: AgentRunRequest
  /** Frontier session JWT — same token the chat path sends. */
  jwt: string
  /** Called once per parsed frame, in stream order. */
  onFrame: (frame: AgentFrame) => void
  /** Aborts the fetch and the stream read loop. */
  signal?: AbortSignal
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Test seam — defaults to AGENT_RUN_URL. */
  url?: string
}

/**
 * Parse a `data:`-prefixed SSE byte stream of AgentFrames. Exported for
 * direct testing with scripted streams (chunk boundaries mid-frame).
 *
 * Unparseable frames are skipped with a console.warn (same posture as the
 * completion stream consumer) — a malformed frame must not kill a run that
 * is otherwise streaming fine.
 */
export async function consumeAgentStream(
  body: ReadableStream<Uint8Array>,
  onFrame: (frame: AgentFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  const processLine = (line: string): void => {
    if (!line.startsWith("data:")) return
    const payload = line.slice(5).trim()
    if (!payload || payload === "[DONE]") return
    let frame: AgentFrame
    try {
      frame = JSON.parse(payload) as AgentFrame
    } catch {
      console.warn("[agent] skipped unparseable SSE frame:", payload.slice(0, 200))
      return
    }
    onFrame(frame)
  }

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Agent run aborted", "AbortError")
      }
      const { done, value } = await reader.read()
      if (done) {
        if (buffer.trim()) processLine(buffer.trim())
        return
      }
      buffer += decoder.decode(value, { stream: true })
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, "")
        buffer = buffer.slice(newlineIdx + 1)
        processLine(line)
      }
    }
  } finally {
    reader.cancel().catch(() => { /* already closed */ })
  }
}

/**
 * Run the agent once. Resolves when the stream closes (the `done`/`error`
 * frames have already been delivered through `onFrame`); rejects on network
 * failure, non-2xx response, or abort (DOMException "AbortError").
 */
export async function runAgent(options: RunAgentOptions): Promise<void> {
  const { request, jwt, onFrame, signal } = options
  const doFetch = options.fetchImpl ?? fetch
  const res = await doFetch(options.url ?? AGENT_RUN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(request),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    if (res.status === 402) {
      throw new Error(`AI limit reached: ${text || "Out of credits."}`)
    }
    throw new Error(`Agent run failed: ${res.status} ${text}`)
  }
  if (!res.body) {
    throw new Error("Agent run failed: response had no body")
  }
  await consumeAgentStream(res.body, onFrame, signal)
}

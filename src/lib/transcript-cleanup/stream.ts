// Reading the cleanup route's reply (auth-worker/src/routes/ai-transcript-cleanup.ts).
//
// Asked with `stream: true`, the route answers in Server-Sent Events: `delta`
// frames with the transcript as the model writes it, then one `result` frame.
// A server that predates streaming, and a test double, answer with one JSON
// body instead — the same `{ model, result }` — so both are read here and the
// caller cannot tell them apart except that `onText` never fires for JSON.

import type { CleanupParse } from "./prompt"

export interface CleanupReply {
  model?: string
  result?: CleanupParse
}

export class CleanupStreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CleanupStreamError"
  }
}

/**
 * Read a 2xx reply to its end. `onText` gets the whole transcript written so
 * far each time more of it arrives. Throws `CleanupStreamError` when the
 * stream carries an error frame or stops before its result.
 */
export async function readCleanupReply(res: Response, onText?: (text: string) => void): Promise<CleanupReply> {
  const type = res.headers.get("Content-Type") ?? ""
  if (!type.includes("text/event-stream") || !res.body) return (await res.json()) as CleanupReply

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let text = ""
  let reply: CleanupReply | null = null
  const frame = (block: string) => {
    let event = "message"
    let data = ""
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) data += line.slice(5).trim()
    }
    if (!data) return
    const parsed = JSON.parse(data) as { add?: unknown; message?: unknown } & CleanupReply
    if (event === "delta" && typeof parsed.add === "string") {
      text += parsed.add
      onText?.(text)
    } else if (event === "result") {
      reply = { model: parsed.model, result: parsed.result }
    } else if (event === "error") {
      throw new CleanupStreamError(typeof parsed.message === "string" ? parsed.message : "cleanup stream failed")
    }
  }
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, "\n")
      let end: number
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        frame(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (!reply) throw new CleanupStreamError("cleanup stream ended before its result")
  return reply
}

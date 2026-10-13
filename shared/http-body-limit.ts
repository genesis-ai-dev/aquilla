/**
 * Request-body size gates for the worker upload boundaries (AQU-1858).
 *
 * A Worker isolate has ~128 MB of memory shared by every request running on
 * it, so a route that materializes its body *before* it has decided to accept
 * the request lets one caller — authenticated or not — evict everybody else.
 * Both readers here are therefore header-first: a declared `Content-Length`
 * over the ceiling is refused without reading a byte, and a chunked body with
 * no declared length is read through a counter that aborts the stream the
 * moment it crosses the ceiling.
 *
 * Runtime-neutral (no Cloudflare, Node, or browser imports) so the sync worker
 * and the auth worker enforce the identical rule, and so the rule itself is
 * unit-testable from the root suite.
 */

/** The subset of `Headers` these gates need, so a plain object works in tests. */
export interface HeaderLookup {
  get(name: string): string | null
}

export interface BodyTooLarge {
  ok: false
  status: 413
  /** Caller-facing reason; safe to return in a response body. */
  error: string
  maxBytes: number
}

export type TextBodyRead = { ok: true; text: string } | BodyTooLarge
export type BytesBodyRead = { ok: true; bytes: Uint8Array } | BodyTooLarge

/**
 * True when the request *declares* a body larger than `maxBytes`.
 *
 * A missing, empty, or unparseable `Content-Length` is not a refusal on its
 * own — those bodies are still read, but through the streaming cap below, so
 * dropping the header cannot buy an attacker an unbounded read.
 */
export function declaresOversizeBody(headers: HeaderLookup, maxBytes: number): boolean {
  const declared = headers.get("content-length")
  if (declared === null || declared.trim() === "") return false
  const bytes = Number(declared)
  return Number.isFinite(bytes) && bytes > maxBytes
}

function tooLarge(maxBytes: number): BodyTooLarge {
  return {
    ok: false,
    status: 413,
    error: `request body exceeds the ${maxBytes}-byte limit`,
    maxBytes,
  }
}

/**
 * Read the body as text, refusing anything over `maxBytes`.
 *
 * Decoding happens chunk by chunk so peak memory stays on the order of the
 * decoded text rather than the bytes *and* the text; a null body (GET-shaped
 * request) reads as the empty string. Use the returned text with `JSON.parse`
 * instead of `request.json()`, which has no way to stop early.
 */
export async function readTextBodyWithLimit(
  headers: HeaderLookup,
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<TextBodyRead> {
  if (declaresOversizeBody(headers, maxBytes)) return tooLarge(maxBytes)
  if (!body) return { ok: true, text: "" }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let seen = 0
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    seen += value.byteLength
    if (seen > maxBytes) {
      void reader.cancel()
      return tooLarge(maxBytes)
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return { ok: true, text }
}

/**
 * Read the body as bytes, refusing anything over `maxBytes`.
 *
 * For routes whose parser needs the raw octets (a multipart upload): read
 * through this first, then hand the capped bytes to the parser, so the parser
 * never sees more than the route is willing to hold.
 */
export async function readBytesWithLimit(
  headers: HeaderLookup,
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BytesBodyRead> {
  if (declaresOversizeBody(headers, maxBytes)) return tooLarge(maxBytes)
  if (!body) return { ok: true, bytes: new Uint8Array(0) }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let seen = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    seen += value.byteLength
    if (seen > maxBytes) {
      void reader.cancel()
      return tooLarge(maxBytes)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(seen)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes }
}

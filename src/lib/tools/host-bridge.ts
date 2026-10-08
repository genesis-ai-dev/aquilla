/**
 * The host half of the Aquilla Tools bridge: message validation, dispatch,
 * permission gating and live event push. UI-free so it can be unit-tested
 * against the real in-frame runtime (runtime-source.ts).
 *
 * Trust rules:
 * - Only messages whose `source` IS the tool frame's contentWindow are read,
 *   and (by default) only from the opaque origin "null" a sandboxed srcdoc
 *   frame without allow-same-origin has.
 * - Every call is authorized by method → scope BEFORE its handler runs; the
 *   handler never sees a call the user did not allow.
 * - Replies go to that one window. targetOrigin must be "*" because an opaque
 *   origin cannot be named; the reply carries only what that tool asked for.
 */

import { removedApi } from "../../../shared/tools/api-rev"

export class BridgeError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "BridgeError"
  }
}

export type BridgeHandler = (params: unknown) => Promise<unknown>

export interface ToolErrorReport {
  message: string
  stack: string
}

export interface BridgeHostOptions {
  getFrameWindow: () => Window | null
  handlers: Readonly<Record<string, BridgeHandler>>
  /** Resolve to allow, throw BridgeError("permission_denied") to refuse. */
  authorize: (method: string) => Promise<void>
  onReady?: () => void
  onToolError?: (err: ToolErrorReport) => void
  /** A tool called a removed bridge API (see shared/tools/api-rev.ts). */
  onApiRemoved?: (method: string, message: string) => void
  /** Called for every completed call (for activity/debug surfaces). */
  onCall?: (method: string, ok: boolean) => void
  /** Origins accepted from the frame. Default: the opaque origin "null". */
  allowedOrigins?: readonly string[]
  maxInFlight?: number
}

export interface BridgeHost {
  handleMessage: (e: MessageEvent) => void
  /** Push a live event (`cells.changed`, `theme`, …) into the frame. */
  push: (event: { type: string } & Record<string, unknown>) => void
  /** Listen on `target` (default window) until the returned disposer runs. */
  listen: (target?: Window) => () => void
}

interface CallMessage {
  channel: "aquilla-tool"
  type: "call"
  requestId: string
  method: string
  params: unknown
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isCall(v: Record<string, unknown>): v is Record<string, unknown> & CallMessage {
  return (
    v.type === "call" &&
    typeof v.requestId === "string" &&
    v.requestId.length > 0 &&
    v.requestId.length <= 100 &&
    typeof v.method === "string" &&
    v.method.length <= 100
  )
}

export function createBridgeHost(opts: BridgeHostOptions): BridgeHost {
  const allowedOrigins = opts.allowedOrigins ?? ["null"]
  const maxInFlight = opts.maxInFlight ?? 64
  let inFlight = 0

  const post = (msg: Record<string, unknown>) => {
    const win = opts.getFrameWindow()
    if (!win) return
    win.postMessage({ ...msg, channel: "aquilla-host" }, "*")
  }

  const reply = (requestId: string, result: { ok: true; value: unknown } | { ok: false; code: string; message: string }) => {
    if (result.ok) post({ type: "result", requestId, ok: true, value: result.value })
    else post({ type: "result", requestId, ok: false, error: { code: result.code, message: result.message } })
  }

  const run = async (call: CallMessage) => {
    const handler = Object.prototype.hasOwnProperty.call(opts.handlers, call.method)
      ? opts.handlers[call.method]
      : undefined
    const removed = handler ? null : removedApi(call.method)
    if (removed) {
      // Removed-API marker: fail loudly with the replacement, and let the host
      // offer "this extension is old → rebuild".
      const message = `aquilla.${call.method} was removed in apiRev ${removed.removedIn}; use ${removed.replacement}`
      reply(call.requestId, { ok: false, code: "api_removed", message })
      opts.onApiRemoved?.(call.method, message)
      opts.onCall?.(call.method, false)
      return
    }
    if (!handler) {
      reply(call.requestId, { ok: false, code: "unknown_method", message: `aquilla.${call.method} does not exist` })
      opts.onCall?.(call.method, false)
      return
    }
    if (inFlight >= maxInFlight) {
      reply(call.requestId, { ok: false, code: "rate_limited", message: "too many calls in flight" })
      return
    }
    inFlight++
    try {
      await opts.authorize(call.method)
      const value = await handler(call.params)
      reply(call.requestId, { ok: true, value: value === undefined ? null : value })
      opts.onCall?.(call.method, true)
    } catch (err) {
      const code = err instanceof BridgeError ? err.code : "error"
      const message = err instanceof Error ? err.message : String(err)
      reply(call.requestId, { ok: false, code, message })
      opts.onCall?.(call.method, false)
    } finally {
      inFlight--
    }
  }

  const handleMessage = (e: MessageEvent) => {
    const frame = opts.getFrameWindow()
    if (!frame || e.source !== frame) return
    if (!allowedOrigins.includes(e.origin)) return
    const msg: unknown = e.data
    if (!isRecord(msg) || msg.channel !== "aquilla-tool") return
    if (msg.type === "ready") {
      opts.onReady?.()
      return
    }
    if (msg.type === "error") {
      opts.onToolError?.({
        message: typeof msg.message === "string" ? msg.message.slice(0, 1000) : "tool error",
        stack: typeof msg.stack === "string" ? msg.stack.slice(0, 4000) : "",
      })
      return
    }
    if (isCall(msg)) void run(msg)
  }

  return {
    handleMessage,
    push: (event) => post({ type: "event", event }),
    listen: (target: Window = window) => {
      target.addEventListener("message", handleMessage)
      return () => target.removeEventListener("message", handleMessage)
    },
  }
}

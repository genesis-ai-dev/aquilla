import { Hono } from "hono"
import type { Context } from "hono"
import { ApiError, envelope, type ErrorCode } from "./errors"
import { resolveWorkspacePath } from "./paths"
import { execCode } from "./exec"
import { decodeBase64, encodeBase64 } from "./base64"
import type { ResolveSandbox, SandboxLike } from "./sandbox"
import type { Env } from "./types"

/** Uploads via /files are capped at 25MB decoded (contract §1). */
export const FILE_PUT_MAX_BYTES = 25 * 1024 * 1024

export interface AppDeps {
  /** Injectable so tests can supply a fake sandbox (no Docker in CI). */
  resolveSandbox: ResolveSandbox
}

function jsonError(c: Context, code: ErrorCode, message: string): Response {
  return c.json(envelope(code, message), statusFor(code))
}

function statusFor(code: ErrorCode): 400 | 401 | 404 | 413 | 500 {
  switch (code) {
    case "unauthorized":
      return 401
    case "not_found":
      return 404
    case "validation_failed":
      return 400
    case "too_large":
      return 413
    case "exec_failed":
      return 500
  }
}

/** Narrow "file not found" detection across sandbox read failures. */
function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /not\s*found|no such file|enoent|does not exist|404/i.test(msg)
}

/**
 * Constant-time bearer-token check (adversarial-panel authz-m1). A naive
 * `token !== expected` short-circuits on the first differing byte, leaking token
 * length/prefix through timing. We SHA-256 both sides (fixed 32-byte digests,
 * so length never leaks) and compare with a no-early-exit XOR accumulator.
 */
async function tokenMatches(token: string, expected: string): Promise<boolean> {
  if (!expected) return false
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(token)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ])
  const av = new Uint8Array(a)
  const bv = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i]
  return diff === 0
}

export function createApp(deps: AppDeps): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()

  // Health check — no auth (contract §1).
  app.get("/health", (c) => c.json({ ok: true }))

  // Bearer auth on everything else.
  app.use("*", async (c, next) => {
    const expected = c.env.AGENT_SANDBOX_KEY
    const auth = c.req.header("Authorization") ?? ""
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : ""
    if (!(await tokenMatches(token, expected))) {
      return jsonError(c, "unauthorized", "missing or invalid bearer token")
    }
    await next()
  })

  const sandboxFor = (c: Context<{ Bindings: Env }>): SandboxLike => {
    const sessionId = c.req.param("sessionId")
    if (!sessionId) throw new ApiError("validation_failed", "sessionId is required")
    return deps.resolveSandbox(c.env, sessionId)
  }

  // POST /sessions/:sessionId/exec
  app.post("/sessions/:sessionId/exec", async (c) => {
    const body = await c.req.json<{ language?: string; code?: string; timeoutMs?: number }>().catch(() => null)
    if (!body || (body.language !== "js" && body.language !== "python")) {
      return jsonError(c, "validation_failed", "language must be 'js' or 'python'")
    }
    if (typeof body.code !== "string" || body.code.length === 0) {
      return jsonError(c, "validation_failed", "code is required")
    }
    try {
      const out = await execCode(sandboxFor(c), {
        language: body.language,
        code: body.code,
        timeoutMs: body.timeoutMs,
      })
      return c.json(out)
    } catch (err) {
      return jsonError(c, "exec_failed", err instanceof Error ? err.message : String(err))
    }
  })

  // POST /sessions/:sessionId/files — write a file into the container.
  app.post("/sessions/:sessionId/files", async (c) => {
    const body = await c.req.json<{ path?: string; contentBase64?: string }>().catch(() => null)
    if (!body || typeof body.path !== "string" || typeof body.contentBase64 !== "string") {
      return jsonError(c, "validation_failed", "path and contentBase64 are required")
    }
    let target: string
    try {
      target = resolveWorkspacePath(body.path)
    } catch (err) {
      return apiErr(c, err)
    }
    const bytes = decodeBase64(body.contentBase64)
    if (bytes.length > FILE_PUT_MAX_BYTES) {
      return jsonError(c, "too_large", `file exceeds ${FILE_PUT_MAX_BYTES} bytes`)
    }
    try {
      await sandboxFor(c).writeFile(target, body.contentBase64, { encoding: "base64" })
      return c.json({ ok: true })
    } catch (err) {
      return jsonError(c, "exec_failed", err instanceof Error ? err.message : String(err))
    }
  })

  // GET /sessions/:sessionId/files?path= — read raw bytes back out.
  app.get("/sessions/:sessionId/files", async (c) => {
    const raw = c.req.query("path")
    if (!raw) return jsonError(c, "validation_failed", "path query param is required")
    let target: string
    try {
      target = resolveWorkspacePath(raw)
    } catch (err) {
      return apiErr(c, err)
    }
    try {
      const res = await sandboxFor(c).readFile(target, { encoding: "base64" })
      if (!res.success) return jsonError(c, "not_found", "file not found")
      const bytes = decodeBase64(res.content)
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      })
    } catch (err) {
      if (isNotFound(err)) return jsonError(c, "not_found", "file not found")
      return jsonError(c, "exec_failed", err instanceof Error ? err.message : String(err))
    }
  })

  // POST /sessions/:sessionId/fetch-artifact — R2 object → container file.
  app.post("/sessions/:sessionId/fetch-artifact", async (c) => {
    const body = await c.req.json<{ key?: string; path?: string }>().catch(() => null)
    if (!body || typeof body.key !== "string" || typeof body.path !== "string") {
      return jsonError(c, "validation_failed", "key and path are required")
    }
    let target: string
    try {
      target = resolveWorkspacePath(body.path)
    } catch (err) {
      return apiErr(c, err)
    }
    const obj = await c.env.SNAPSHOTS.get(body.key)
    if (!obj) return jsonError(c, "not_found", `artifact ${body.key} not found`)
    const bytes = new Uint8Array(await obj.arrayBuffer())
    try {
      await sandboxFor(c).writeFile(target, encodeBase64(bytes), { encoding: "base64" })
      return c.json({ ok: true, bytes: bytes.length })
    } catch (err) {
      return jsonError(c, "exec_failed", err instanceof Error ? err.message : String(err))
    }
  })

  // DELETE /sessions/:sessionId — destroy the container (idempotent).
  app.delete("/sessions/:sessionId", async (c) => {
    try {
      await sandboxFor(c).destroy()
    } catch (err) {
      // Idempotent: a missing/already-destroyed container is still success.
      if (!isNotFound(err)) {
        return jsonError(c, "exec_failed", err instanceof Error ? err.message : String(err))
      }
    }
    return c.json({ ok: true })
  })

  return app
}

function apiErr(c: Context<{ Bindings: Env }>, err: unknown): Response {
  if (err instanceof ApiError) return jsonError(c, err.code, err.message)
  return jsonError(c, "exec_failed", err instanceof Error ? err.message : String(err))
}

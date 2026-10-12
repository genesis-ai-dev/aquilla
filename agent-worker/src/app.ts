import { Hono } from "hono"
import type { Context } from "hono"
import { ApiError, envelope, type ErrorCode } from "./errors"
import { resolveWorkspacePath } from "./paths"
import { execCode, MAX_TIMEOUT_MS } from "./exec"
import { decodeBase64, encodeBase64 } from "./base64"
import { shipLog, shipErrorResponse } from "./posthog-logs"
import type { ResolveSandbox, SandboxLike } from "./sandbox"
import { admitWithWait, ANONYMOUS_TENANT, POOL_DO_NAME, type PoolGate, type WaitedAdmitResult } from "./pool"
import type { Env } from "./types"

/** Uploads via /files are capped at 25MB decoded (contract §1). */
export const FILE_PUT_MAX_BYTES = 25 * 1024 * 1024

// AQU-1021 / AQU-1005: requests slower than this are logged even when they
// SUCCEED — only-4xx/5xx logging left saturation invisible until it collapsed.
// A [slow-request] line — in `pnpm dev` output or PostHog Logs — is a defect to
// investigate, not noise. Matches auth-worker / sync-worker.
export const SLOW_REQUEST_MS = 5_000

/**
 * `/exec` is the one route where a multi-second request is the *contract*, not
 * a defect: callers get `DEFAULT_TIMEOUT_MS` (60s) and may ask for up to
 * `MAX_TIMEOUT_MS` (300s). Holding it to the 5s bar would warn on every normal
 * agent run and train devs to ignore the line — which is exactly the signal
 * AQU-1005 was protecting. So exec only warns when it outlives its own hard
 * ceiling, which means the timeout race in `execCode` failed to fire.
 */
export function slowThresholdFor(path: string): number {
  return path.endsWith("/exec") ? MAX_TIMEOUT_MS : SLOW_REQUEST_MS
}

export interface AppDeps {
  /** Injectable so tests can supply a fake sandbox (no Docker in CI). */
  resolveSandbox: ResolveSandbox
  /**
   * AQU-1848: admission control for the container pool. Injectable for the same
   * reason as `resolveSandbox` — route tests drive an in-memory ledger instead
   * of a Durable Object.
   */
  pool: PoolGate
  /** Injected so the full-pool wait is instant in tests. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * AQU-1848: how long a request will wait for a slot before giving up with
 * `pool_busy`. Kept well under the Worker's own request budget so the caller
 * gets a structured 503 rather than a timeout, and overridable per environment
 * via `SANDBOX_POOL_WAIT_MS`.
 */
export const DEFAULT_POOL_WAIT_MS = 20_000

/**
 * Opaque tenant key, set by auth-worker (`user:<id>`). It is the unit the
 * per-tenant cap counts, so that one project lead firing off sandbox imports
 * cannot take every slot from everyone else. Absent means `anonymous` — all
 * such callers then share one tenant budget, which is the safe default.
 */
export const TENANT_HEADER = "X-Sandbox-Tenant"

function jsonError(c: Context, code: ErrorCode, message: string): Response {
  return c.json(envelope(code, message), statusFor(code))
}

/**
 * Hono throws on `c.executionCtx` when there is none (vitest calls `app.fetch`
 * without a ctx), so resolve it defensively and fall back to un-awaited
 * fire-and-forget. Telemetry must never take down a request.
 */
function runInBackground(c: Context<{ Bindings: Env }>, task: Promise<void>): void {
  try {
    c.executionCtx.waitUntil(task)
  } catch {
    void task
  }
}

function statusFor(code: ErrorCode): 400 | 401 | 404 | 413 | 500 | 503 {
  switch (code) {
    case "unauthorized":
      return 401
    case "not_found":
      return 404
    case "validation_failed":
      return 400
    case "too_large":
      return 413
    case "pool_busy":
      return 503
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

/**
 * AQU-1848: take (or renew) this session's pool lease before touching a
 * container.
 *
 * A full pool is waited out — that is the point of the ticket, and it is why
 * the third concurrent run completes instead of failing at container-start.
 * Being over the caller's OWN per-tenant cap is refused at once: waiting there
 * would park the caller behind its own containers.
 */
async function admitSession(
  c: Context<{ Bindings: Env }>,
  sessionId: string,
  deps: AppDeps,
): Promise<WaitedAdmitResult> {
  const tenant = c.req.header(TENANT_HEADER)?.trim() || ANONYMOUS_TENANT
  const configured = Number(c.env.SANDBOX_POOL_WAIT_MS)
  const maxWaitMs = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_POOL_WAIT_MS
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  return admitWithWait(deps.pool, c.env, { sessionId, tenant }, {
    maxWaitMs,
    sleep,
    now: () => Date.now(),
  })
}

/**
 * The `pool_busy` response. The message is written to be shown to a person —
 * it is what the import dialog surfaces when every sandbox is taken — and
 * `Retry-After` lets a caller back off without guessing.
 */
function poolBusy(c: Context<{ Bindings: Env }>, admitted: WaitedAdmitResult): Response {
  if (admitted.granted) throw new Error("poolBusy called on a granted admission")
  const message = admitted.reason === "tenant_full"
    ? `You already have ${admitted.activeForTenant} sandbox runs in flight. Wait for one to finish and try again.`
    : "Waiting for a sandbox — every sandbox is busy right now. Please try again in a moment."
  const retryAfterSec = Math.max(1, Math.ceil(admitted.retryAfterMs / 1000))
  console.warn(
    `[sandbox-pool] ${admitted.reason} after ${admitted.waitedMs}ms (active ${admitted.activeTotal}, tenant ${admitted.activeForTenant})`,
  )
  return c.json(envelope("pool_busy", message), 503, { "Retry-After": String(retryAfterSec) })
}

export function createApp(deps: AppDeps): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()

  // Observability (AQU-1021): slow requests, 4xx/5xx responses and unhandled
  // throws go to the worker log + PostHog Logs (fire-and-forget; no-op when
  // POSTHOG_KEY is unset — see posthog-logs.ts). Registered FIRST so it wraps
  // every route including /health and the bearer-auth rejections below; Hono
  // runs matched handlers in registration order, so a route declared earlier
  // would return before this middleware ever ran.
  app.use("*", async (c, next) => {
    const startedAt = Date.now()
    try {
      await next()
    } catch (err) {
      runInBackground(
        c,
        shipLog(c.env, "aquilla-agent-sandbox", "error", `unhandled: ${c.req.method} ${c.req.path}`, {
          "http.method": c.req.method,
          "http.path": c.req.path,
          "http.duration_ms": Date.now() - startedAt,
          "error.message": err instanceof Error ? err.message : String(err),
        }),
      )
      throw err
    }
    const durationMs = Date.now() - startedAt
    if (durationMs >= slowThresholdFor(c.req.path)) {
      console.warn(
        `[slow-request] ${c.req.method} ${c.req.path} took ${durationMs}ms (status ${c.res.status})`,
      )
      runInBackground(
        c,
        shipLog(c.env, "aquilla-agent-sandbox", "warn", `slow: ${c.req.method} ${c.req.path} (${durationMs}ms)`, {
          "http.method": c.req.method,
          "http.path": c.req.path,
          "http.status": c.res.status,
          "http.duration_ms": durationMs,
        }),
      )
    }
    if (c.res.status >= 400) {
      runInBackground(c, shipErrorResponse(c.env, "aquilla-agent-sandbox", c.req.raw, c.res))
    }
  })

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

  /**
   * AQU-1848: `sandboxFor` plus a pool lease. Every route that may START a
   * container goes through here, so the global and per-tenant caps are
   * enforced in one place; a session that already holds a lease just renews it,
   * which keeps a long-running run alive without consuming a second slot.
   */
  type Claim = { ok: true; sandbox: SandboxLike } | { ok: false; res: Response }
  const claimSandbox = async (c: Context<{ Bindings: Env }>): Promise<Claim> => {
    const sessionId = c.req.param("sessionId")
    if (!sessionId) return { ok: false, res: jsonError(c, "validation_failed", "sessionId is required") }
    const admitted = await admitSession(c, sessionId, deps)
    if (!admitted.granted) return { ok: false, res: poolBusy(c, admitted) }
    return { ok: true, sandbox: deps.resolveSandbox(c.env, sessionId) }
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
    const claim = await claimSandbox(c)
    if (!claim.ok) return claim.res
    try {
      const out = await execCode(claim.sandbox, {
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
    const claim = await claimSandbox(c)
    if (!claim.ok) return claim.res
    try {
      await claim.sandbox.writeFile(target, body.contentBase64, { encoding: "base64" })
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
    const claim = await claimSandbox(c)
    if (!claim.ok) return claim.res
    try {
      await claim.sandbox.writeFile(target, encodeBase64(bytes), { encoding: "base64" })
      return c.json({ ok: true, bytes: bytes.length })
    } catch (err) {
      return jsonError(c, "exec_failed", err instanceof Error ? err.message : String(err))
    }
  })

  // DELETE /sessions/:sessionId — destroy the container (idempotent).
  app.delete("/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId")
    try {
      await sandboxFor(c).destroy()
    } catch (err) {
      // Idempotent: a missing/already-destroyed container is still success.
      if (!isNotFound(err)) {
        // AQU-1848: give the slot back even when teardown reports a real
        // failure. Holding the lease would punish the next caller for a
        // container this one has already stopped using, and the container is
        // the pool's TTL to reap either way.
        if (sessionId) await deps.pool.release(c.env, sessionId)
        return jsonError(c, "exec_failed", err instanceof Error ? err.message : String(err))
      }
    }
    if (sessionId) await deps.pool.release(c.env, sessionId)
    return c.json({ ok: true })
  })

  // AQU-1848: pool occupancy, for the dev-stack and for confirming the caps
  // actually bite under load. Bearer-gated like every other route.
  app.get("/pool/stats", async (c) => {
    const ns = c.env.SANDBOX_POOL
    try {
      const res = await ns.get(ns.idFromName(POOL_DO_NAME)).fetch("https://sandbox-pool/stats")
      return c.json(await res.json() as Record<string, unknown>)
    } catch (err) {
      return jsonError(c, "exec_failed", err instanceof Error ? err.message : String(err))
    }
  })

  return app
}

function apiErr(c: Context<{ Bindings: Env }>, err: unknown): Response {
  if (err instanceof ApiError) return jsonError(c, err.code, err.message)
  return jsonError(c, "exec_failed", err instanceof Error ? err.message : String(err))
}

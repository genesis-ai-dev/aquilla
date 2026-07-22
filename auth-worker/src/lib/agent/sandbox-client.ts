// AQU-AGENT §1/§2 — HTTP client for the sandbox worker (aquilla-agent-sandbox).
//
// The harness (agent.ts) calls the sandbox over HTTP for code execution,
// artifact loading, and file reads. All routes require
// `Authorization: Bearer ${AGENT_SANDBOX_KEY}`. Base URL = env.AGENT_SANDBOX_URL;
// local dev may inject :8790 or an explicitly configured deployed endpoint.
//
// Every call degrades to a CLEAR "sandbox unavailable" result when the URL or
// key is unset, or the worker is unreachable — the model sees a tool error it
// can reason about, never a thrown 500 that kills the run (contracts §6/§2).

/** The subset of Env this client needs — declared locally so the module is
 *  import-light and testable without the full worker Env. */
export interface SandboxEnv {
  AGENT_SANDBOX_URL?: string
  AGENT_SANDBOX_KEY?: string
}

/** Result of a sandbox `exec` — mirrors the §1 response envelope. */
export interface SandboxExecResult {
  ok: boolean
  stdout: string
  stderr: string
  resultJson?: string
  durationMs: number
  truncated?: boolean
}

/** Discriminated outcome so callers never have to catch: `available:false`
 *  carries the human-readable reason to surface to the model. */
export type SandboxOutcome<T> =
  | { available: true; data: T }
  | { available: false; reason: string }

const SANDBOX_UNAVAILABLE =
  "sandbox unavailable — code execution is not configured for this deployment (AGENT_SANDBOX_URL/AGENT_SANDBOX_KEY unset)"

/** Base + key, or null when the sandbox is not configured. */
function resolveSandbox(env: SandboxEnv): { base: string; key: string } | null {
  const base = env.AGENT_SANDBOX_URL?.trim()
  const key = env.AGENT_SANDBOX_KEY?.trim()
  if (!base || !key) return null
  return { base: base.replace(/\/$/, ""), key }
}

async function sandboxFetch(
  env: SandboxEnv,
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<SandboxOutcome<Response>> {
  const cfg = resolveSandbox(env)
  if (!cfg) return { available: false, reason: SANDBOX_UNAVAILABLE }
  try {
    const res = await fetch(`${cfg.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        ...(init.headers ?? {}),
      },
      signal,
    })
    return { available: true, data: res }
  } catch (err) {
    // Network failure / connection refused — the sandbox is unreachable.
    return {
      available: false,
      reason: `sandbox unreachable — ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** Parse a §1 error envelope `{error:{code,message}}` into a flat message. */
async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    if (body?.error) return `${body.error.code ?? "error"}: ${body.error.message ?? ""}`.trim()
  } catch {
    /* non-JSON body */
  }
  return `sandbox returned HTTP ${res.status}`
}

/** POST /sessions/:sessionId/exec — run code in the session container. */
export async function sandboxExec(
  env: SandboxEnv,
  sessionId: string,
  body: { language: "js" | "python"; code: string; timeoutMs?: number },
  signal?: AbortSignal,
): Promise<SandboxOutcome<SandboxExecResult>> {
  const out = await sandboxFetch(
    env,
    `/sessions/${encodeURIComponent(sessionId)}/exec`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    signal,
  )
  if (!out.available) return out
  const res = out.data
  if (!res.ok) return { available: false, reason: await readError(res) }
  const data = (await res.json()) as SandboxExecResult
  return { available: true, data }
}

/** POST /sessions/:sessionId/fetch-artifact — worker copies R2 object `key`
 *  into the container at `path`. Returns `{ bytes }` on success. */
export async function sandboxFetchArtifact(
  env: SandboxEnv,
  sessionId: string,
  body: { key: string; path: string },
  signal?: AbortSignal,
): Promise<SandboxOutcome<{ bytes: number }>> {
  const out = await sandboxFetch(
    env,
    `/sessions/${encodeURIComponent(sessionId)}/fetch-artifact`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    signal,
  )
  if (!out.available) return out
  const res = out.data
  if (!res.ok) return { available: false, reason: await readError(res) }
  const data = (await res.json()) as { ok: boolean; bytes: number }
  return { available: true, data: { bytes: data.bytes } }
}

/** GET /sessions/:sessionId/files?path= — raw bytes, decoded utf-8 and capped
 *  at `maxBytes` (default 48KB per contracts §2 read_sandbox_file). */
export async function sandboxReadFile(
  env: SandboxEnv,
  sessionId: string,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<SandboxOutcome<{ text: string; truncated: boolean }>> {
  const out = await sandboxFetch(
    env,
    `/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`,
    { method: "GET" },
    signal,
  )
  if (!out.available) return out
  const res = out.data
  if (res.status === 404) return { available: false, reason: `not_found: ${path}` }
  if (!res.ok) return { available: false, reason: await readError(res) }
  const buf = new Uint8Array(await res.arrayBuffer())
  const truncated = buf.byteLength > maxBytes
  const slice = truncated ? buf.subarray(0, maxBytes) : buf
  const text = new TextDecoder("utf-8").decode(slice)
  return { available: true, data: { text, truncated } }
}

/** DELETE /sessions/:sessionId — destroy the container (idempotent, best-effort). */
export async function sandboxDestroy(env: SandboxEnv, sessionId: string): Promise<void> {
  const out = await sandboxFetch(env, `/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  })
  // Best-effort teardown: swallow the result. A leaked container is the
  // sandbox worker's TTL to reap, never the run's problem.
  if (out.available) {
    try {
      await out.data.text()
    } catch {
      /* ignore */
    }
  }
}

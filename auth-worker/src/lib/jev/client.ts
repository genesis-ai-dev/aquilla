/**
 * jev/client.ts — the one place that talks to Jev (TypeSafe's decisions model
 * through OpenRouter). Shared by the seam route and decide(); neither owns the
 * URL, the credential, or the timeout on its own.
 */

import type { Env } from "../../types"
import { JEV_DECISIONS_URL } from "../../../../src/lib/completion/seam-request"

/**
 * Resolve the decisions endpoint.
 *
 * OpenRouter fronts TypeSafe's evaluation API at `/api/alpha/decisions`, a
 * sibling of `/api/v1` rather than a path under it — so deriving it from
 * OPENROUTER_BASE_URL means replacing the version segment, not appending. The
 * dev stack's scripted mock (OPENROUTER_BASE_URL=http://127.0.0.1:9999/v1)
 * lands on /alpha/decisions the same way production does.
 */
export function resolveDecisionsUrl(env: Pick<Env, "OPENROUTER_BASE_URL">): string {
  const base = env.OPENROUTER_BASE_URL?.trim()
  if (!base) return JEV_DECISIONS_URL
  const trimmed = base.replace(/\/+$/, "")
  const withoutVersion = trimmed.replace(/\/v\d+$/, "")
  return `${withoutVersion}/alpha/decisions`
}

export type JevCallResult =
  | { ok: true; body: unknown }
  | { ok: false; reason: "no_key" | "timeout" | "upstream" }

/** One decisions call. Never throws: every failure is a reason the caller maps
 *  onto its own fixed-rule fallback. */
export async function callJev(
  env: Pick<Env, "OPENROUTER_API_KEY" | "OPENROUTER_BASE_URL">,
  request: unknown,
  timeoutMs: number,
): Promise<JevCallResult> {
  if (!env.OPENROUTER_API_KEY) return { ok: false, reason: "no_key" }
  if (timeoutMs <= 0) return { ok: false, reason: "timeout" }
  try {
    const res = await fetch(resolveDecisionsUrl(env), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      console.warn(`[jev] upstream ${res.status}`)
      return { ok: false, reason: "upstream" }
    }
    return { ok: true, body: await res.json() }
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError"
    console.warn(`[jev] call failed (${timedOut ? "timeout" : "error"}):`, err)
    return { ok: false, reason: timedOut ? "timeout" : "upstream" }
  }
}

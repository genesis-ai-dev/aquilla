/**
 * jev/client.ts — the one place that talks to Jev (TypeSafe's decisions model
 * through OpenRouter). Shared by the seam, passage-tag, harmonizer and
 * smart-edit routes and by decide(); none of them owns the URL, the
 * credential, the timeout or the billing on its own.
 *
 * AQU-2064: every call passes the one entitlement check on the `jev` rail
 * (plan, key, platform ceiling, and a reservation while the meter is on) and
 * settles from the tokens Jev reports, priced in lib/billing/rate-card.ts.
 */

import type { Env } from "../../types"
import { JEV_DECISIONS_URL } from "../../../../src/lib/completion/seam-request"
import { admitPaidCall } from "../billing/paid-call"
import { holdChatUsage, releaseChatUsage } from "../billing/chat-usage"
import { jevBoundCents, jevCostCents } from "../billing/rate-card"
import { settleWorkspaceUsage } from "../billing/workspace-usage"

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
  /** `refused`: the entitlement check said no (allowance, platform ceiling,
   *  no billing workspace while metered). The caller falls back as for any failure. */
  | { ok: false; reason: "no_key" | "timeout" | "upstream" | "refused" }

/** Who a Jev call bills: the project's org, and the person asking. `userId`
 *  null is the system — a cron sweep or background run (spec §3.3). */
export interface JevBilling { projectId: string; userId: number | null }

/** The tokens a decisions reply reports, or null when it reports none. */
export function jevUsageOf(body: unknown): { input_tokens: number; output_tokens: number } | null {
  const u = body && typeof body === "object" ? (body as { usage?: unknown }).usage : undefined
  if (!u || typeof u !== "object") return null
  const { input_tokens, output_tokens } = u as Record<string, unknown>
  return typeof input_tokens === "number" && typeof output_tokens === "number"
    ? { input_tokens, output_tokens }
    : null
}

/** One decisions call. Never throws: every failure is a reason the caller maps
 *  onto its own fixed-rule fallback. */
export async function callJev(
  env: Env,
  request: unknown,
  timeoutMs: number,
  billing: JevBilling,
): Promise<JevCallResult> {
  if (!env.OPENROUTER_API_KEY) return { ok: false, reason: "no_key" }
  if (timeoutMs <= 0) return { ok: false, reason: "timeout" }
  const body = JSON.stringify(request)
  let orgId = 0
  try {
    const project = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = ?")
      .bind(billing.projectId).first<{ org_id: number | null }>()
    orgId = project?.org_id ?? 0
  } catch { /* org 0: refused while metered, legacy (ceiling only) while off */ }
  const gate = await admitPaidCall(env, { orgId, userId: billing.userId, projectId: billing.projectId,
    rail: "jev", estimate: () => jevBoundCents(body.length) })
  if (!gate.ok) {
    console.warn(`[jev] refused by the entitlement check (${gate.status} ${gate.body.error})`)
    return { ok: false, reason: gate.status === 503 && gate.body.error === "provider_unconfigured" ? "no_key" : "refused" }
  }
  const { usage } = gate
  try {
    const res = await fetch(resolveDecisionsUrl(env), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gate.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      console.warn(`[jev] upstream ${res.status}`)
      // A 4xx other than 408 is refused before the model runs: proven free.
      // Anything less certain keeps the reservation for reconciliation.
      if (usage && res.status >= 400 && res.status < 500 && res.status !== 408) await releaseChatUsage(env, usage)
      return { ok: false, reason: "upstream" }
    }
    const reply: unknown = await res.json()
    if (usage) {
      const tokens = jevUsageOf(reply)
      if (!tokens) await holdChatUsage(env, usage, undefined)
      else {
        try { await settleWorkspaceUsage(env.AQUILLA_PG, usage.orgId, usage.requestId, jevCostCents(tokens)) }
        catch { console.warn("[billing] jev usage requires reconciliation", usage) }
      }
    }
    return { ok: true, body: reply }
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError"
    console.warn(`[jev] call failed (${timedOut ? "timeout" : "error"}):`, err)
    return { ok: false, reason: timedOut ? "timeout" : "upstream" }
  }
}

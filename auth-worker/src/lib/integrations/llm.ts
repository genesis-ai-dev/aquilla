// The one non-streaming OpenRouter call the integration setups make (Monday's
// board analysis, Airtable's table analysis — AQU-804): a direct fetch in JSON
// mode, admitted by the AI entitlement check (AQU-2063), plus
// the lenient JSON extraction both need because a model's "strict JSON" is
// sometimes wrapped in a code fence or prose.

import type { Env } from "../../types"
import { openRouterUsage } from "../llm-vendor"
import { admitLlmCall, LlmRefusedError, type PaidScope } from "../billing/paid-llm"
import {
  isAbortTimeout,
  logVendorTimeout,
  VENDOR_TIMEOUT_MS,
} from "../../../../shared/vendor-timeouts"

/** Thrown when the AI upstream itself is unavailable (non-2xx) — the route
 *  turns this into a clean 502, never a misleading "invalid JSON". */
export class AnalyzeUpstreamError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`AI provider unavailable (HTTP ${status})`)
    this.name = "AnalyzeUpstreamError"
    this.status = status
  }
}

/**
 * Extract the first balanced JSON object from possibly-messy LLM output:
 * strips markdown code fences, then brace-scans (string-aware) so leading or
 * trailing prose around the object doesn't break parsing.
 */
export function extractJsonObject(content: string): string | null {
  let text = content.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fence) text = fence[1].trim()
  const start = text.indexOf("{")
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** The first JSON object in the model's answer, parsed, or null. */
export function parseJsonAnswer<T extends object>(content: string): Partial<T> | null {
  const json = extractJsonObject(content)
  if (!json) return null
  try {
    return JSON.parse(json) as Partial<T>
  } catch {
    return null
  }
}

/** Output the meter reserves per call. The request sends no max_tokens (a
 *  clipped JSON answer is useless), so this only sizes the reservation. */
const ANALYSIS_RESERVE_OUTPUT_TOKENS = 4_096

/** One completion. `label` names the caller in the server-side error log.
 *  AQU-2063: admitted before it spends (a refusal throws LlmRefusedError for
 *  the route to answer) and settles the usage.cost the provider reports. */
export async function callAnalysisLlm(
  env: Env, scope: PaidScope, model: string, prompt: string, label: string,
): Promise<string> {
  const call = await admitLlmCall(env.AQUILLA_PG, env, scope, {
    model, promptChars: prompt.length, maxOutputTokens: ANALYSIS_RESERVE_OUTPUT_TOKENS,
  })
  if (!call.ok) throw new LlmRefusedError(call)
  const base = env.OPENROUTER_BASE_URL
    ? env.OPENROUTER_BASE_URL.replace(/\/$/, "")
    : "https://openrouter.ai/api/v1"
  let upstream: Response
  try {
    upstream = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${call.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        stream: false,
        response_format: { type: "json_object" },
        ...openRouterUsage(env.OPENROUTER_BASE_URL),
      }),
      // AQU-1849: `stream: false`, so nothing arrives until the completion is
      // whole — this one deadline therefore bounds the entire answer. A blown
      // one becomes the same AnalyzeUpstreamError the wizard already renders,
      // carrying a 504 status.
      signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS.openRouterNonStreaming),
    })
  } catch (err) {
    if (isAbortTimeout(err)) {
      logVendorTimeout("openRouterNonStreaming", err)
      throw new AnalyzeUpstreamError(504)
    }
    throw err
  }
  if (!upstream.ok) {
    // Log the body snippet server-side only — never surfaced to the client.
    const text = await upstream.text().catch(() => "")
    console.error(`[${label}] upstream HTTP ${upstream.status}: ${text.slice(0, 300)}`)
    throw new AnalyzeUpstreamError(upstream.status)
  }
  const data = (await upstream.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  await call.settleFrom(data)
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error("LLM returned no content")
  return content
}

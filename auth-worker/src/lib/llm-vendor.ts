// OpenRouter-specific request fields, gated on the upstream actually being
// OpenRouter.
//
// Every AI surface in this worker speaks OpenAI chat-completions and can be
// pointed at a different upstream via OPENROUTER_BASE_URL — the scripted dev
// mock (scripts/mock-openrouter.ts), Groq, Anthropic's OpenAI-compatible layer,
// a self-hosted server. OpenRouter accepts two vendor extensions we rely on:
// `usage.include` (per-request cost, read by the credit ledger) and
// `reasoning.effort` (suppress reasoning tokens). Neither is part of the OpenAI
// schema, and not every upstream ignores unknown fields — Groq hard-rejects
// with `400 property 'reasoning' is unsupported`. Emit them only for OpenRouter.

/** True when `baseUrl` targets OpenRouter, including the unset default. */
export function isOpenRouterUpstream(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim()
  if (!trimmed) return true // unset → https://openrouter.ai/api/v1
  try {
    const { hostname } = new URL(trimmed)
    return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai")
  } catch {
    return false // unparseable override — assume a non-OpenRouter upstream
  }
}

/**
 * `stream_options.include_usage` — the OpenAI-standard way to get a usage block
 * on a STREAMED response.
 *
 * OpenRouter reports streamed usage through its own `usage.include` extension
 * (above), so it neither needs nor wants this. Every other OpenAI-compatible
 * upstream omits usage from streams unless asked: llama.cpp/llama-swap, vLLM,
 * Groq. Without it `readModelTurn` sees no usage at all, so the agent loop
 * counts zero tokens — which silently disables the TOKEN_CEILING guard and
 * writes zeros to agent_runs and the credit ledger. Non-streaming call sites
 * are unaffected (they always get usage).
 */
export function streamUsageOptions(
  baseUrl?: string,
): { stream_options?: { include_usage: true } } {
  return isOpenRouterUpstream(baseUrl) ? {} : { stream_options: { include_usage: true } }
}

/** `usage.include` only — for call sites that never sent a reasoning hint. */
export function openRouterUsage(baseUrl?: string): { usage?: { include: true } } {
  return isOpenRouterUpstream(baseUrl) ? { usage: { include: true } } : {}
}

/** `usage.include` + `reasoning.effort` — spread into a chat-completions body. */
export function openRouterExtras(
  baseUrl?: string,
  effort: "none" | "low" | "medium" | "high" = "none",
): { usage?: { include: true }; reasoning?: { effort: string } } {
  if (!isOpenRouterUpstream(baseUrl)) return {}
  return { usage: { include: true }, reasoning: { effort } }
}

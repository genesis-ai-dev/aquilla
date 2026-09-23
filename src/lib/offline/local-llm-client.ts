/**
 * local-llm-client — talks to the Rust axum proxy in `src-tauri/src/llm_proxy.rs`:
 * `POST /llm/chat` → `{endpoint}/v1/chat/completions`, `GET /llm/models` →
 * `{endpoint}/v1/models`. Both are the OpenAI-compatible shape — matches
 * Ollama's own `/v1` compat layer, LM Studio, llama.cpp server, vLLM, and
 * text-generation-webui alike, same `{choices: [{message: {content}}]}`
 * response `completion-service.ts` already parses for the "custom" provider.
 * Every request carries `?endpoint=` explicitly (see `resolve_endpoint` on the
 * Rust side) rather than relying solely on the proxy's persisted config, so
 * testing/detecting against an edited-but-not-yet-Saved endpoint works
 * correctly. No Tauri JS API needed here — the proxy is a plain local HTTP
 * server, reachable with `fetch()` like any other endpoint (CSP already
 * allows `http://localhost:49152`, see `tauri.conf.json`).
 */

import { isTauriRuntime } from "./is-tauri"
import { isOnline } from "./connectivity"
import { getLocalLlmSettings, type LocalLlmSettings } from "./llm-settings"

export const LOCAL_LLM_PROXY_URL = "http://localhost:49152/llm/chat"
export const LOCAL_LLM_MODELS_URL = "http://localhost:49152/llm/models"

export interface LocalLlmMessage {
  role: "system" | "user" | "assistant"
  content: string
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * True only when running in the Tauri desktop shell AND currently offline —
 * the one condition under which chat/completion requests route to the local
 * LLM proxy instead of the hosted Frontier/custom provider. Per the project
 * design: "Rust backend proxies LLM requests offline; upstream OpenRouter
 * when online."
 */
export async function shouldUseLocalLlm(): Promise<boolean> {
  if (!isTauriRuntime()) return false
  return (await isOnline()) === false
}

async function postLocalLlm(
  messages: LocalLlmMessage[],
  settings: LocalLlmSettings,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const forwardAbort = () => controller.abort()
  opts?.signal?.addEventListener("abort", forwardAbort, { once: true })
  try {
    // The endpoint travels as an explicit query param on every request rather
    // than relying on Rust's persisted LlmConfig — that keeps this correct
    // even for an in-progress (not yet Saved) endpoint value, e.g. from the
    // "Test connection" button, and removes any dependency on
    // LocalLlmConfigMount's push having already landed by request time.
    const url = `${LOCAL_LLM_PROXY_URL}?endpoint=${encodeURIComponent(settings.endpoint)}`
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: settings.model, messages, stream: false }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Local LLM request failed: ${res.status} ${text || res.statusText}`.trim())
    }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    return typeof content === "string" ? content.trim() : ""
  } finally {
    clearTimeout(timer)
    opts?.signal?.removeEventListener("abort", forwardAbort)
  }
}

/** Complete a chat request against the configured local LLM (no streaming — v1). */
export async function completeWithLocalLlm(
  messages: LocalLlmMessage[],
  opts?: { signal?: AbortSignal },
): Promise<string> {
  return postLocalLlm(messages, getLocalLlmSettings(), { signal: opts?.signal })
}

/**
 * Lists model ids available at `endpoint` via its OpenAI-compatible
 * `/v1/models` listing (Ollama's own compat layer, LM Studio, llama.cpp
 * server, vLLM, and text-generation-webui all support this shape) — lets the
 * Settings UI offer a "Detect models" picker instead of requiring the exact
 * id to be typed. Note LM Studio's `/v1/models` only lists what's currently
 * *loaded* (typically one model); Ollama's lists everything *pulled*.
 */
export async function listLocalLlmModels(endpoint: string): Promise<string[]> {
  const url = `${LOCAL_LLM_MODELS_URL}?endpoint=${encodeURIComponent(endpoint)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Couldn't list models: ${res.status} ${text || res.statusText}`.trim())
    }
    const data = await res.json()
    const list = Array.isArray(data?.data) ? data.data : []
    return list
      .map((m: { id?: unknown }) => m?.id)
      .filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
  } finally {
    clearTimeout(timer)
  }
}

export interface LocalLlmConnectionTestResult {
  ok: boolean
  message: string
}

/** Sends a trivial prompt through the real proxy path to verify reachability. */
export async function testLocalLlmConnection(
  settings: LocalLlmSettings,
): Promise<LocalLlmConnectionTestResult> {
  try {
    const content = await postLocalLlm(
      [{ role: "user", content: "Reply with just the word: pong" }],
      settings,
      { timeoutMs: 15_000 },
    )
    return {
      ok: true,
      message: content ? `Connected — replied "${content.slice(0, 60)}"` : "Connected.",
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Connection failed.",
    }
  }
}

/**
 * llm-settings — device-scoped configuration for the offline local LLM
 * (Phase 6). Tauri-only feature, but this module has zero Tauri dependency
 * itself (plain localStorage, same pattern as
 * `src/lib/store/audio-quality-pref.ts`) so it can be imported unconditionally
 * without pulling `@tauri-apps/api` into the browser SPA bundle.
 *
 * Defaults mirror `src-tauri/src/llm_proxy.rs`'s `LlmConfig::default()`
 * (Ollama's own defaults) so an unconfigured install and a freshly-launched
 * Rust process agree without any sync happening yet.
 *
 * This module only stores the setting. Pushing it into the Rust-side
 * `LlmConfig` (so `llm_proxy.rs` actually proxies to it) is
 * `LocalLlmConfigMount`'s job — it reacts to `useLocalLlmSettings()`.
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.offline-llm.v1"

export interface LocalLlmSettings {
  endpoint: string
  model: string
}

export const DEFAULT_LOCAL_LLM_SETTINGS: LocalLlmSettings = {
  endpoint: "http://localhost:11434",
  model: "llama3",
}

const listeners = new Set<() => void>()

/** Cached snapshot so useSyncExternalStore gets a stable value between writes. */
let cached: LocalLlmSettings | undefined

function notify(): void {
  for (const l of listeners) l()
}

function read(): LocalLlmSettings {
  if (typeof localStorage === "undefined") return DEFAULT_LOCAL_LLM_SETTINGS
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_LOCAL_LLM_SETTINGS
    const parsed = JSON.parse(raw) as Partial<LocalLlmSettings>
    const endpoint = typeof parsed.endpoint === "string" && parsed.endpoint.trim()
      ? parsed.endpoint.trim()
      : DEFAULT_LOCAL_LLM_SETTINGS.endpoint
    const model = typeof parsed.model === "string" && parsed.model.trim()
      ? parsed.model.trim()
      : DEFAULT_LOCAL_LLM_SETTINGS.model
    return { endpoint, model }
  } catch {
    return DEFAULT_LOCAL_LLM_SETTINGS
  }
}

function peek(): LocalLlmSettings {
  if (cached === undefined) cached = read()
  return cached
}

/** Plain (non-React) read of the current local LLM settings. */
export function getLocalLlmSettings(): LocalLlmSettings {
  return peek()
}

export function setLocalLlmSettings(settings: LocalLlmSettings): void {
  const next: LocalLlmSettings = {
    endpoint: settings.endpoint.trim() || DEFAULT_LOCAL_LLM_SETTINGS.endpoint,
    model: settings.model.trim() || DEFAULT_LOCAL_LLM_SETTINGS.model,
  }
  cached = next
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // quota / access denied — the in-memory cache still reflects the edit
    }
  }
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reactive read of the local LLM settings. */
export function useLocalLlmSettings(): LocalLlmSettings {
  return useSyncExternalStore(subscribe, peek, () => DEFAULT_LOCAL_LLM_SETTINGS)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetLocalLlmSettingsCacheForTests(): void {
  cached = undefined
}

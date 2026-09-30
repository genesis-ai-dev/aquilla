import { useEffect } from "react"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { useLocalLlmSettings } from "@/lib/offline/llm-settings"

/**
 * Invisible mount: keeps the Rust-side LLM proxy config
 * (`src-tauri/src/llm_proxy.rs`'s `LlmConfig`) in sync with the JS-persisted
 * local LLM settings. Necessary because Rust's `LlmConfig::default()` resets
 * to its own hardcoded defaults on every cold boot — without this, a
 * previously-saved custom endpoint/model would silently stop taking effect
 * after restarting the app. Reactive via `useLocalLlmSettings()`, so a save
 * in `LocalLlmSection` also re-pushes immediately.
 */
export function LocalLlmConfigMount() {
  const settings = useLocalLlmSettings()

  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => {
        if (cancelled) return undefined
        return invoke("set_llm_config", { endpoint: settings.endpoint, model: settings.model })
      })
      .catch(() => {
        // Not-yet-ready IPC bridge or a mocked isTauriRuntime() in tests —
        // the proxy just keeps whatever config it already has.
      })
    return () => {
      cancelled = true
    }
  }, [settings])

  return null
}

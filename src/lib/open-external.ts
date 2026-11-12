// Leaves the app for an external page (Stripe, OAuth providers).
//
// In the Tauri desktop app this opens the system browser instead of
// navigating the app window: `window.open` returns null in the WebView, and a
// full-page navigation away freezes the app page in WebKit's bfcache (see
// src/lib/offline/bfcache-guard.ts). The browser SPA navigates as before.
import { isTauriRuntime } from "@/lib/offline/is-tauri"

export async function openExternal(url: string): Promise<void> {
  if (!isTauriRuntime()) {
    window.location.assign(url)
    return
  }
  // Dynamically imported so the browser SPA never pulls @tauri-apps/api into
  // its bundle. `plugin:opener|open_url` is what @tauri-apps/plugin-opener's
  // openUrl() invokes; tauri-plugin-opener is already registered in
  // src-tauri/src/lib.rs and allowed by `opener:default`.
  const { invoke } = await import("@tauri-apps/api/core")
  await invoke("plugin:opener|open_url", { url })
}

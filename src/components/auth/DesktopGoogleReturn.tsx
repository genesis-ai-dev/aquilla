import { useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { acceptDesktopGoogleReturn } from "@/lib/frontier/google-login"
import { setDesktopGoogleReturn } from "@/lib/frontier/google-return"

/** Subscribe before draining the native queue, so callbacks during app startup
 * are not lost. The queue and attempt both consume each handoff only once. */
export function DesktopGoogleReturn() {
  const navigate = useNavigate()
  useEffect(() => {
    if (!isTauriRuntime()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const [{ invoke }, { listen }] = await Promise.all([import("@tauri-apps/api/core"), import("@tauri-apps/api/event")])
      const drain = async () => {
        if (disposed) return
        const value = await invoke<string | null>("take_google_callback")
        if (!value || disposed) return
        const params = acceptDesktopGoogleReturn(value)
        if (!params) return
        setDesktopGoogleReturn(params)
        navigate("/auth/google/return", { replace: true, state: null })
      }
      unlisten = await listen("auth://google-return", () => { void drain() })
      if (disposed) { unlisten(); return }
      await drain()
    })().catch(() => { /* Older shells cannot complete native Google sign-in. */ })
    return () => { disposed = true; unlisten?.() }
  }, [navigate])
  return null
}

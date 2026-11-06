import { useEffect } from "react"
import { bundleBooted } from "@/lib/offline/bundle-update"
import { isTauriRuntime } from "@/lib/offline/is-tauri"

type Props = {
  booted?: () => Promise<void>
}

/**
 * Tells the Tauri shell the web bundle booted. The shell writes a `pending`
 * marker when it applies a staged hot bundle; if the next launch still finds
 * it, that bundle never got this far and is rolled back (hot_bundle.rs). So
 * this must run once the SPA has actually mounted — and only then.
 */
export function HotBundleBoot({ booted = bundleBooted }: Props): null {
  useEffect(() => {
    if (!isTauriRuntime()) return
    booted().catch((error: unknown) => console.warn("[bundle] bundle_booted failed", error))
  }, [booted])
  return null
}

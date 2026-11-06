import { useEffect, useState } from "react"
import { toast } from "@/components/ui/toast"
import { useT } from "@/lib/i18n/I18nProvider"
import type { BundleEventName, BundleEventPayloads, StagedBundle } from "@/lib/offline/bundle-update"
import { isTauriRuntime } from "@/lib/offline/is-tauri"

const ROLLED_BACK_TOAST_ID = "desktop-bundle-rolled-back"

export type SubscribeBundleEvent = <Name extends BundleEventName>(
  name: Name,
  onEvent: (payload: BundleEventPayloads[Name]) => void,
) => () => void

export interface HotBundleSource {
  /** `check_bundle_update`: idempotent, null when nothing new is staged. */
  checkBundle: () => Promise<StagedBundle | null>
  subscribe: SubscribeBundleEvent
}

interface Options {
  source: HotBundleSource
  /** From useConnectivity: null until known. */
  online: boolean | null
  /** The shell is too old for the newest bundle; the caller runs its shell update check. Pass a stable callback. */
  onShellOutdated: () => void
}

/**
 * Tracks the hot web bundle the shell has staged for the next launch. Checks on
 * mount when online and on every offline→online transition (the shell fetches
 * the manifest on the same edges, so this picks up what it staged), and listens
 * for `bundle://staged` in between. The caller gates "Restart to update" on the
 * offline queues exactly as it does the shell update — this hook only reports.
 */
export function useStagedHotBundle({ source, online, onShellOutdated }: Options): StagedBundle | null {
  const t = useT()
  const [staged, setStaged] = useState<StagedBundle | null>(null)

  useEffect(() => {
    if (!isTauriRuntime() || online !== true) return
    let cancelled = false
    source
      .checkBundle()
      .then((found) => {
        if (!cancelled && found) setStaged(found)
      })
      .catch((error: unknown) => console.warn("[bundle] check failed", error))
    return () => {
      cancelled = true
    }
  }, [source, online])

  useEffect(() => {
    if (!isTauriRuntime()) return
    const unsubscribeStaged = source.subscribe("bundle://staged", setStaged)
    const unsubscribeOutdated = source.subscribe("bundle://shell-outdated", onShellOutdated)
    const unsubscribeRolledBack = source.subscribe("bundle://rolled-back", () => {
      // Dedupe by id: a stuck marker should warn once, not on every re-emit.
      toast.add({
        id: ROLLED_BACK_TOAST_ID,
        type: "warning",
        timeout: 0,
        title: t("workspace.update.rolledBackToast"),
      })
    })
    return () => {
      unsubscribeStaged()
      unsubscribeOutdated()
      unsubscribeRolledBack()
    }
  }, [source, onShellOutdated, t])

  return staged
}

import { useEffect } from "react"
import { toast } from "@/components/ui/toast"
import { useOfflineStore } from "@/context/OfflineStoreContext"
import { useT } from "@/lib/i18n/I18nProvider"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import type { LeaderLogEntry } from "@/lib/offline/leader-log-bridge"
import { setLeaderStalled, watchLeaderLiveness } from "@/lib/offline/leader-watchdog"

const LEADER_STALLED_TOAST_ID = "offline-leader-stalled"
const LOG_TAIL = 40

// Module-level so it's referentially stable — a fresh default each render
// would re-run the effect and reset the stall clock.
//
// Restarts the app rather than reloading the page: WKWebView can leave an
// unloaded page's busy leader frozen, still holding the OPFS files, until the
// WebContent process exits, so a reload just boots another dead leader
// (livestorejs/livestore#244). `restart_app` runs the same save handshake as
// a quit first (src-tauri/src/shutdown_guard.rs).
const restartApp = (): void => {
  if (!isTauriRuntime()) {
    window.location.reload()
    return
  }
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("restart_app"))
    .catch(() => window.location.reload())
}

type Props = {
  stallMs?: number
  checkEveryMs?: number
  restart?: () => void
}

/**
 * Invisible mount: warns when the offline store's leader worker stops
 * persisting writes (see src/lib/offline/leader-watchdog.ts for why that is
 * otherwise silent). Prompts rather than auto-restarting, so an edit in
 * progress isn't yanked away mid-keystroke. A restart boots a fresh leader.
 *
 * Rendered alongside the other invisible offline mounts in App.tsx.
 */
export function OfflineLeaderWatchdog({ stallMs, checkEveryMs, restart = restartApp }: Props): null {
  const { store } = useOfflineStore()
  const t = useT()

  useEffect(() => {
    if (!store) return
    return watchLeaderLiveness(store, {
      stallMs,
      checkEveryMs,
      onStall: (stall) => {
        setLeaderStalled(true)
        const leaderLogs = (window as Window & { __leaderLogs?: LeaderLogEntry[] }).__leaderLogs
        console.error("[offline] LiveStore leader stopped persisting writes", {
          ...stall,
          leaderLogs: leaderLogs?.slice(-LOG_TAIL),
        })
        toast.add({
          id: LEADER_STALLED_TOAST_ID,
          type: "error",
          timeout: 0,
          title: t("workspace.offline.leaderStalledToast"),
          actionProps: {
            children: t("workspace.offline.leaderStalledRestart"),
            onClick: restart,
          },
        })
      },
      onRecover: () => {
        setLeaderStalled(false)
        toast.close(LEADER_STALLED_TOAST_ID)
      },
    })
  }, [store, stallMs, checkEveryMs, restart, t])

  return null
}

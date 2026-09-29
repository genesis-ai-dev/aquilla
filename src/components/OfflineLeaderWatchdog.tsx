import { useEffect } from "react"
import { toast } from "@/components/ui/toast"
import { useOfflineStore } from "@/context/OfflineStoreContext"
import { useT } from "@/lib/i18n/I18nProvider"
import type { LeaderLogEntry } from "@/lib/offline/leader-log-bridge"
import { watchLeaderLiveness } from "@/lib/offline/leader-watchdog"

const LEADER_STALLED_TOAST_ID = "offline-leader-stalled"
const LOG_TAIL = 40

// Module-level so it's referentially stable — a fresh default each render
// would re-run the effect and reset the stall clock.
const reloadWindow = () => window.location.reload()

type Props = {
  stallMs?: number
  checkEveryMs?: number
  reload?: () => void
}

/**
 * Invisible mount: warns when the offline store's leader worker stops
 * persisting writes (see src/lib/offline/leader-watchdog.ts for why that is
 * otherwise silent). Prompts rather than auto-reloading, so an edit in
 * progress isn't yanked away mid-keystroke. A reload boots a fresh leader.
 *
 * Rendered alongside the other invisible offline mounts in App.tsx.
 */
export function OfflineLeaderWatchdog({ stallMs, checkEveryMs, reload = reloadWindow }: Props): null {
  const { store } = useOfflineStore()
  const t = useT()

  useEffect(() => {
    if (!store) return
    return watchLeaderLiveness(store, {
      stallMs,
      checkEveryMs,
      onStall: (stall) => {
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
            children: t("workspace.offline.leaderStalledReload"),
            onClick: reload,
          },
        })
      },
      onRecover: () => toast.close(LEADER_STALLED_TOAST_ID),
    })
  }, [store, stallMs, checkEveryMs, reload, t])

  return null
}

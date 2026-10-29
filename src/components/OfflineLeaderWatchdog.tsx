import { useEffect } from "react"
import { toast } from "@/components/ui/toast"
import { useOfflineStore } from "@/context/OfflineStoreContext"
import { useT } from "@/lib/i18n/I18nProvider"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import type { LeaderLogEntry } from "@/lib/offline/leader-log-bridge"
import { setLeaderStalled, watchLeaderLiveness } from "@/lib/offline/leader-watchdog"
import { getOfflineBootProgress } from "@/lib/offline/boot-progress"

const LEADER_STALLED_TOAST_ID = "offline-leader-stalled"
const SLOW_BOOT_TOAST_ID = "offline-slow-boot"
const PREPARING_TOAST_ID = "offline-preparing"
// The store only exists once the leader has booted (store.ts disables the
// fast path), which includes rebuilding the state db after a schema change —
// minutes on a big store. The rebuild reports progress (boot-progress.ts), so
// this only prompts a restart once boot has gone this long with no progress.
const DEFAULT_BOOT_STALL_MS = 30_000
// Once a rebuild is under way the leader can go minutes between events: on a
// real 34k-cell store one 200 KB batch took 111 s, with the worker's event
// loop blocked the whole time (2026-10-29), so a heartbeat can't tell a busy
// leader from a dead one. Allow much longer before suggesting a restart.
const DEFAULT_REBUILD_STALL_MS = 5 * 60_000
const DEFAULT_BOOT_CHECK_EVERY_MS = 1_000
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
  bootStallMs?: number
  rebuildStallMs?: number
  bootCheckEveryMs?: number
  stallMs?: number
  checkEveryMs?: number
  restart?: () => void
}

/**
 * Invisible mount: warns when the offline store's leader worker stops
 * persisting writes (see src/lib/offline/leader-watchdog.ts for why that is
 * otherwise silent), or never boots the store at all — a dead leader never
 * hands one out, so there's nothing for the stall check to watch. While the
 * leader is rebuilding offline data after an update it shows that progress
 * instead, and only prompts if the rebuild stops moving. Prompts
 * rather than auto-restarting, so an edit in progress isn't yanked away
 * mid-keystroke. A restart boots a fresh leader.
 *
 * Rendered alongside the other invisible offline mounts in App.tsx.
 */
export function OfflineLeaderWatchdog({
  bootStallMs = DEFAULT_BOOT_STALL_MS,
  rebuildStallMs = DEFAULT_REBUILD_STALL_MS,
  bootCheckEveryMs = DEFAULT_BOOT_CHECK_EVERY_MS,
  stallMs,
  checkEveryMs,
  restart = restartApp,
}: Props): null {
  const { store, loading } = useOfflineStore()
  const t = useT()

  useEffect(() => {
    if (!loading) return
    const startedAt = Date.now()
    let shown: "preparing" | "slow" | null = null
    const check = () => {
      const progress = getOfflineBootProgress()
      const quietForMs = Date.now() - Math.max(startedAt, progress.lastProgressAt)
      if (quietForMs >= (progress.rebuilding ? rebuildStallMs : bootStallMs)) {
        if (shown === "slow") return
        if (shown === "preparing") toast.close(PREPARING_TOAST_ID)
        shown = "slow"
        const leaderLogs = (window as Window & { __leaderLogs?: LeaderLogEntry[] }).__leaderLogs
        console.error("[offline] LiveStore store still hasn't booted", {
          waitedMs: Date.now() - startedAt,
          quietForMs,
          progress,
          leaderLogs: leaderLogs?.slice(-LOG_TAIL),
        })
        toast.add({
          id: SLOW_BOOT_TOAST_ID,
          type: "warning",
          timeout: 0,
          title: t("workspace.offline.slowBootToast"),
          actionProps: {
            children: t("workspace.offline.leaderStalledRestart"),
            onClick: restart,
          },
        })
        return
      }
      if (!progress.rebuilding) {
        if (shown === "preparing") {
          toast.close(PREPARING_TOAST_ID)
          shown = null
        }
        return
      }
      // A rebuild that's moving gets progress, not a restart prompt — a
      // restart would only start the replay over from the first event.
      if (shown === "slow") toast.close(SLOW_BOOT_TOAST_ID)
      const title = t("workspace.offline.preparingToast", {
        percent: Math.floor((progress.done / progress.total) * 100),
      })
      if (shown === "preparing") {
        toast.update(PREPARING_TOAST_ID, { title })
        return
      }
      shown = "preparing"
      toast.add({
        id: PREPARING_TOAST_ID,
        type: "loading",
        timeout: 0,
        title,
        description: t("workspace.offline.preparingToastDescription"),
      })
    }
    const timer = setInterval(check, bootCheckEveryMs)
    return () => {
      clearInterval(timer)
      toast.close(SLOW_BOOT_TOAST_ID)
      toast.close(PREPARING_TOAST_ID)
    }
  }, [loading, bootStallMs, rebuildStallMs, bootCheckEveryMs, restart, t])

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

import { useEffect, useEffectEvent } from "react"
import { toast } from "@/components/ui/toast"
import { useOfflineStore } from "@/context/OfflineStoreContext"
import { useT } from "@/lib/i18n/I18nProvider"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import type { LeaderLogEntry } from "@/lib/offline/leader-log-bridge"
import { setLeaderStalled, watchLeaderLiveness } from "@/lib/offline/leader-watchdog"
import { getOfflineBootProgress } from "@/lib/offline/boot-progress"
import { rescueUnpersistedOfflineWrites } from "@/lib/sync/outbox"

const LEADER_STALLED_TOAST_ID = "offline-leader-stalled"
const SLOW_BOOT_TOAST_ID = "offline-slow-boot"
const PREPARING_TOAST_ID = "offline-preparing"
// A rescue that couldn't write to IndexedDB (a full disk) tries again this
// often while the leader stays stalled.
const DEFAULT_RESCUE_RETRY_MS = 10_000
// The store only exists once the leader has booted (store.ts disables the
// fast path), which includes rebuilding the state db after a schema change —
// minutes on a big store. The rebuild reports progress (boot-progress.ts), so
// this only prompts a restart once boot has gone this long with no progress.
const DEFAULT_BOOT_STALL_MS = 30_000
// Once a rebuild is under way the leader's event loop is blocked between
// progress reports, so neither a heartbeat nor a short timeout can tell a busy
// leader from a hung one. Before the rebuild ran in one transaction, single
// 200 KB batches took 111 s and 318 s on a real 34k-cell store (2026-10-29);
// the whole rebuild now takes ~13 s there. After this long the toast says it's
// still working; a restart would only start the replay over.
const DEFAULT_SLOW_REBUILD_MS = 60_000
// Most rebuilds now finish in seconds; one shorter than this would only flash
// a toast, so the progress toast waits until the rebuild has run this long.
const DEFAULT_SHOW_REBUILD_AFTER_MS = 2_000
// After this long with no progress at all the leader is almost certainly hung
// (or killed without failing the boot), so the toast offers a restart after all.
const DEFAULT_HUNG_REBUILD_MS = 5 * 60_000
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
  showRebuildAfterMs?: number
  slowRebuildMs?: number
  hungRebuildMs?: number
  bootCheckEveryMs?: number
  stallMs?: number
  checkEveryMs?: number
  restart?: () => void
  rescue?: () => Promise<boolean>
  rescueRetryMs?: number
}

/**
 * Invisible mount: warns when the offline store's leader worker stops
 * persisting writes (see src/lib/offline/leader-watchdog.ts for why that is
 * otherwise silent), or never boots the store at all — a dead leader never
 * hands one out, so there's nothing for the stall check to watch. While the
 * leader is rebuilding offline data after an update it shows that progress
 * instead, and only offers a restart once the rebuild has made no progress for
 * minutes. Prompts
 * rather than auto-restarting, so an edit in progress isn't yanked away
 * mid-keystroke. A restart boots a fresh leader.
 *
 * Rendered alongside the other invisible offline mounts in App.tsx.
 */
export function OfflineLeaderWatchdog({
  bootStallMs = DEFAULT_BOOT_STALL_MS,
  showRebuildAfterMs = DEFAULT_SHOW_REBUILD_AFTER_MS,
  slowRebuildMs = DEFAULT_SLOW_REBUILD_MS,
  hungRebuildMs = DEFAULT_HUNG_REBUILD_MS,
  bootCheckEveryMs = DEFAULT_BOOT_CHECK_EVERY_MS,
  stallMs,
  checkEveryMs,
  restart = restartApp,
  rescue = rescueUnpersistedOfflineWrites,
  rescueRetryMs = DEFAULT_RESCUE_RETRY_MS,
}: Props): null {
  const { store, loading } = useOfflineStore()
  const t = useT()

  useEffect(() => {
    if (!loading) return
    const startedAt = Date.now()
    let shown: "preparing" | "slow" | null = null
    let loggedSlowRebuild = false
    let loggedHungRebuild = false
    // Whether the preparing toast on screen carries the restart prompt. The
    // user can close that toast, and an update to a closed toast is a no-op,
    // so a rebuild that goes on to hang re-adds it rather than updating.
    let shownHung = false
    const check = () => {
      const progress = getOfflineBootProgress()
      const quietForMs = Date.now() - Math.max(startedAt, progress.lastProgressAt)
      if (progress.rebuilding) {
        // A rebuild gets progress, not a restart prompt: a restart only
        // starts the replay over. Only a rebuild that has stopped moving for
        // minutes (a hung or silently killed leader) offers one.
        if (shown === "slow") {
          toast.close(SLOW_BOOT_TOAST_ID)
          shown = null
        }
        if (shown === null && Date.now() - progress.startedAt < showRebuildAfterMs) return
        const hung = quietForMs >= hungRebuildMs
        const slow = quietForMs >= slowRebuildMs
        if (slow && !loggedSlowRebuild) {
          loggedSlowRebuild = true
          console.warn("[offline] Offline data rebuild has gone quiet", { quietForMs, progress })
        }
        if (hung && !loggedHungRebuild) {
          loggedHungRebuild = true
          const leaderLogs = (window as Window & { __leaderLogs?: LeaderLogEntry[] }).__leaderLogs
          console.error("[offline] Offline data rebuild has made no progress", {
            quietForMs,
            progress,
            leaderLogs: leaderLogs?.slice(-LOG_TAIL),
          })
        }
        const title = t("workspace.offline.preparingToast", {
          percent: Math.floor((progress.done / progress.total) * 100),
        })
        const description = t(
          hung
            ? "workspace.offline.preparingToastStuckDescription"
            : slow
              ? "workspace.offline.preparingToastSlowDescription"
              : "workspace.offline.preparingToastDescription",
        )
        const actionProps = hung ? { children: t("workspace.offline.leaderStalledRestart"), onClick: restart } : undefined
        const becameHung = hung && !shownHung
        shownHung = hung
        if (shown === "preparing" && !becameHung) {
          toast.update(PREPARING_TOAST_ID, { title, description, actionProps })
          return
        }
        shown = "preparing"
        toast.add({ id: PREPARING_TOAST_ID, type: "loading", timeout: 0, title, description, actionProps })
        return
      }
      if (shown === "preparing") {
        toast.close(PREPARING_TOAST_ID)
        shown = null
      }
      if (shown === "slow" || quietForMs < bootStallMs) return
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
    }
    const timer = setInterval(check, bootCheckEveryMs)
    return () => {
      clearInterval(timer)
      toast.close(SLOW_BOOT_TOAST_ID)
      toast.close(PREPARING_TOAST_ID)
    }
  }, [loading, bootStallMs, showRebuildAfterMs, slowRebuildMs, hungRebuildMs, bootCheckEveryMs, restart, t])

  // Effect events, so a language switch doesn't restart the liveness watch
  // (a fresh watcher would forget a stall it hadn't seen begin).
  const showStalledToast = useEffectEvent((safe: boolean) => {
    // Add, not update: an update to a toast the user closed is a no-op, and
    // "your edits are safe" is news worth showing again.
    toast.add({
      id: LEADER_STALLED_TOAST_ID,
      type: safe ? "warning" : "error",
      timeout: 0,
      title: t(safe ? "workspace.offline.leaderStalledBackedUpToast" : "workspace.offline.leaderStalledToast"),
      actionProps: {
        children: t("workspace.offline.leaderStalledRestart"),
        onClick: restart,
      },
    })
  })

  useEffect(() => {
    if (!store) return
    let stalled = false
    // Bumped on every stall and recovery: a rescue started for an earlier
    // stall can resolve after the leader recovered and stalled again, and must
    // not start a second retry loop (or overwrite this one's timer).
    let stallEpoch = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    // Copy what the leader never saved to IndexedDB; once that's done the
    // edits are safe, so the toast stops saying they may be lost. Retried
    // until it succeeds or the leader recovers. Later edits skip the offline
    // queue until the leader recovers, so nothing new needs saving after this.
    const rescueUntilSafe = () => {
      const epoch = stallEpoch
      const settle = (safe: boolean) => {
        if (!stalled || epoch !== stallEpoch) return
        if (safe) {
          showStalledToast(true)
        } else {
          retryTimer = setTimeout(rescueUntilSafe, rescueRetryMs)
        }
      }
      rescue().then(settle, (error: unknown) => {
        console.error("[offline] Couldn't rescue unsaved offline edits", error)
        settle(false)
      })
    }
    const stopWatching = watchLeaderLiveness(store, {
      stallMs,
      checkEveryMs,
      onStall: (stall) => {
        stalled = true
        stallEpoch += 1
        clearTimeout(retryTimer)
        // First, so edits made from here on go to IndexedDB, not the dead queue.
        setLeaderStalled(true)
        const leaderLogs = (window as Window & { __leaderLogs?: LeaderLogEntry[] }).__leaderLogs
        console.error("[offline] LiveStore leader stopped persisting writes", {
          ...stall,
          leaderLogs: leaderLogs?.slice(-LOG_TAIL),
        })
        showStalledToast(false)
        rescueUntilSafe()
      },
      onRecover: () => {
        stalled = false
        stallEpoch += 1
        clearTimeout(retryTimer)
        setLeaderStalled(false)
        toast.close(LEADER_STALLED_TOAST_ID)
      },
    })
    return () => {
      stallEpoch += 1
      clearTimeout(retryTimer)
      stopWatching()
      // The next watcher starts unaware of this stall, so it would never
      // report a recovery: the flag would stay set, and every offline edit
      // would go to IndexedDB for the rest of the session. A store that is
      // still stalled is reported again by the next watcher.
      if (stalled) {
        stalled = false
        setLeaderStalled(false)
        toast.close(LEADER_STALLED_TOAST_ID)
      }
    }
  }, [store, stallMs, checkEveryMs, rescue, rescueRetryMs])

  return null
}

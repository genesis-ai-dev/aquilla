import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "@/components/ui/toast"
import { useOfflineStore } from "@/context/OfflineStoreContext"
import { useStagedHotBundle, type HotBundleSource } from "@/hooks/useStagedHotBundle"
import { useT } from "@/lib/i18n/I18nProvider"
import { checkBundleUpdate, restartApp, subscribeBundleEvent } from "@/lib/offline/bundle-update"
import { useConnectivity } from "@/lib/offline/connectivity"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { tables } from "@/lib/offline/schema"
import { subscribeToOutbox } from "@/lib/sync/outbox"
import {
  addQueues,
  EMPTY_QUEUE,
  evaluateUpdateGate,
  readOfflineQueue,
  readOutboxQueue,
  UPDATE_DRAIN_GRACE_MS,
  type OfflineQueueSnapshot,
} from "@/lib/offline/update-gate"

const UPDATE_TOAST_ID = "desktop-update"
const RECHECK_MS = 6 * 60 * 60_000

/** Mirrors app_update.rs `DownloadedUpdate`. */
export interface DownloadedUpdate {
  version: string
  notes: string | null
}

export interface DesktopUpdateCommands extends HotBundleSource {
  /** Shell (native) update: downloads it if newer. */
  download: () => Promise<DownloadedUpdate | null>
  install: () => Promise<void>
  /** `restart_app`: a staged hot bundle applies on the relaunch. */
  restart: () => Promise<void>
}

// Dynamic import keeps @tauri-apps/api out of the browser bundle.
const tauriCommands: DesktopUpdateCommands = {
  download: async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke<DownloadedUpdate | null>("download_app_update")
  },
  install: async () => {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("install_app_update")
  },
  checkBundle: checkBundleUpdate,
  restart: restartApp,
  subscribe: subscribeBundleEvent,
}

/**
 * Two update sources share one toast and one drain gate. A native shell update
 * wins when both are pending: installing it relaunches, and the staged bundle
 * applies on that launch anyway.
 */
type PendingUpdate = { kind: "shell"; version: string } | { kind: "bundle"; version: string }

type Props = {
  commands?: DesktopUpdateCommands
  recheckMs?: number
  graceMs?: number
}

/** Offers a downloaded desktop update once both offline queues have drained (see update-gate.ts). */
export function DesktopUpdatePrompt({
  commands = tauriCommands,
  recheckMs = RECHECK_MS,
  graceMs = UPDATE_DRAIN_GRACE_MS,
}: Props): null {
  const t = useT()
  const online = useConnectivity()
  const { store, loading: storeLoading } = useOfflineStore()
  const [shellUpdate, setShellUpdate] = useState<DownloadedUpdate | null>(null)
  // Bumped when the shell reports it is too old for the newest bundle: re-run the shell check now.
  const [shellCheckNonce, setShellCheckNonce] = useState(0)
  const [queue, setQueue] = useState<OfflineQueueSnapshot>(EMPTY_QUEUE)
  // undefined = not read yet; null = unreadable.
  const [outbox, setOutbox] = useState<OfflineQueueSnapshot | null | undefined>(undefined)
  const installing = useRef(false)
  const [graceOver, setGraceOver] = useState(false)

  const requestShellCheck = useCallback(() => setShellCheckNonce((n) => n + 1), [])
  const staged = useStagedHotBundle({ source: commands, online, onShellOutdated: requestShellCheck })
  const update = useMemo<PendingUpdate | null>(
    () =>
      shellUpdate
        ? { kind: "shell", version: shellUpdate.version }
        : staged
          ? { kind: "bundle", version: staged.version }
          : null,
    [shellUpdate, staged],
  )

  useEffect(() => {
    if (!isTauriRuntime() || online !== true || shellUpdate) return
    let cancelled = false
    const check = () => {
      commands
        .download()
        .then((found) => {
          if (!cancelled && found) setShellUpdate(found)
        })
        .catch((error: unknown) => console.warn("[update] check failed", error))
    }
    check()
    const timer = setInterval(check, recheckMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [commands, online, shellUpdate, recheckMs, shellCheckNonce])

  useEffect(() => {
    if (!store) return
    const recheck = () => setQueue(readOfflineQueue(store))
    recheck()
    // Statuses only — all readOfflineQueue reads; whole rows would decode every payload per commit.
    return store.subscribe(tables.eventQueue.select("status"), recheck)
  }, [store])

  useEffect(() => {
    if (!isTauriRuntime()) return
    let latest = 0
    const recheck = () => {
      const call = ++latest
      void readOutboxQueue().then((next) => {
        if (call === latest) setOutbox(next)
      })
    }
    recheck()
    const unsubscribe = subscribeToOutbox(recheck)
    return () => {
      latest = -1
      unsubscribe()
    }
  }, [])

  const total = store && outbox ? addQueues(queue, outbox) : null
  const pending = (total?.count ?? 0) > 0
  useEffect(() => {
    if (!update || !pending) return
    const timer = setTimeout(() => setGraceOver(true), graceMs)
    return () => {
      clearTimeout(timer)
      // A fresh backlog after a drain gets its own full grace period.
      setGraceOver(false)
    }
  }, [update, pending, graceMs])

  const gate = storeLoading || outbox === undefined ? null : evaluateUpdateGate(total, graceOver)
  const gateKind = gate?.kind ?? "sending"
  const count = gate?.kind === "sending" || gate?.kind === "stuck" ? gate.count : 0
  const refused = gate?.kind === "stuck" && gate.failed > 0

  useEffect(() => {
    if (!update || gateKind === "sending") {
      toast.close(UPDATE_TOAST_ID)
      return
    }
    const apply = () => {
      // Blocks double-clicks; stays set on success since the app is already exiting.
      if (installing.current) return
      installing.current = true
      if (update.kind === "shell") {
        commands.install().catch((error: unknown) => {
          installing.current = false
          console.warn("[update] install failed", error)
          // Re-checking re-offers the update (re-downloading it if it went missing).
          setShellUpdate(null)
        })
        return
      }
      // The bundle stays staged, so a failed relaunch leaves the offer up to retry.
      commands.restart().catch((error: unknown) => {
        installing.current = false
        console.warn("[update] restart failed", error)
      })
    }
    // The headline stays calm in every state; the caveat is a secondary line.
    const description =
      gateKind === "clear"
        ? undefined
        : gateKind === "unknown"
          ? t("workspace.update.unknownDetail")
          : refused
            ? t("workspace.update.refusedDetail", { count })
            : t("workspace.update.stuckDetail", { count })
    toast.add({
      id: UPDATE_TOAST_ID,
      type: refused ? "warning" : "info",
      timeout: 0,
      title: t("workspace.update.readyToast", { version: update.version }),
      description,
      actionProps: {
        children: gateKind === "clear" ? t("workspace.update.restartToUpdate") : t("workspace.update.updateAnyway"),
        onClick: apply,
      },
    })
  }, [commands, update, gateKind, count, refused, t])

  return null
}

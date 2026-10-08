import { useEffect, useRef, useState } from "react"
import { toast } from "@/components/ui/toast"
import { useOfflineStore } from "@/context/OfflineStoreContext"
import { useT } from "@/lib/i18n/I18nProvider"
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

export interface DesktopUpdateCommands {
  download: () => Promise<DownloadedUpdate | null>
  install: () => Promise<void>
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
}

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
  const [update, setUpdate] = useState<DownloadedUpdate | null>(null)
  const [queue, setQueue] = useState<OfflineQueueSnapshot>(EMPTY_QUEUE)
  // undefined = not read yet; null = unreadable.
  const [outbox, setOutbox] = useState<OfflineQueueSnapshot | null | undefined>(undefined)
  const installing = useRef(false)
  const [graceOver, setGraceOver] = useState(false)

  useEffect(() => {
    if (!isTauriRuntime() || online !== true || update) return
    let cancelled = false
    const check = () => {
      commands
        .download()
        .then((found) => {
          if (!cancelled && found) setUpdate(found)
        })
        .catch((error: unknown) => console.warn("[update] check failed", error))
    }
    check()
    const timer = setInterval(check, recheckMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [commands, online, update, recheckMs])

  useEffect(() => {
    if (!store) return
    const recheck = () => setQueue(readOfflineQueue(store))
    recheck()
    return store.subscribe(tables.eventQueue.select(), recheck)
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
    const install = () => {
      // Blocks double-clicks; stays set on success since the app is already exiting.
      if (installing.current) return
      installing.current = true
      commands.install().catch((error: unknown) => {
        installing.current = false
        console.warn("[update] install failed", error)
        // Re-checking re-offers the update (re-downloading it if it went missing).
        setUpdate(null)
      })
    }
    toast.add({
      id: UPDATE_TOAST_ID,
      type: gateKind === "clear" ? "info" : "warning",
      timeout: 0,
      title:
        gateKind === "clear"
          ? t("workspace.update.readyToast", { version: update.version })
          : gateKind === "unknown"
            ? t("workspace.update.unknownToast", { version: update.version })
            : refused
              ? t("workspace.update.refusedToast", { version: update.version, count })
              : t("workspace.update.stuckToast", { version: update.version, count }),
      actionProps: {
        children: gateKind === "clear" ? t("workspace.update.restartToUpdate") : t("workspace.update.updateAnyway"),
        onClick: install,
      },
    })
  }, [commands, update, gateKind, count, refused, t])

  return null
}

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

/** src-tauri/src/app_update.rs `DownloadedUpdate`. */
export interface DownloadedUpdate {
  version: string
  notes: string | null
}

export interface DesktopUpdateCommands {
  download: () => Promise<DownloadedUpdate | null>
  install: () => Promise<void>
}

// Dynamically imported so the browser SPA never pulls @tauri-apps/api into
// its bundle — same convention as OfflineShutdownGuard.tsx.
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

/**
 * Invisible mount: checks for a desktop update while online, downloads it,
 * and offers to install only once the offline queue has reached the server
 * (src/lib/offline/update-gate.ts for why). If the queue isn't draining it
 * offers "Update anyway" instead — the rows stay in the local store. Both
 * queues count: the offline store's and the IndexedDB outbox. Nothing is
 * offered while the offline store is still booting; if it failed to boot, or
 * the outbox can't be read, the prompt warns rather than claim all is sent.
 * Installing runs the same save handshake as a quit
 * (src-tauri/src/app_update.rs).
 *
 * Rendered alongside the other invisible offline mounts in App.tsx.
 */
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
  // Undefined until the first read lands; null if IndexedDB couldn't be read.
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

  // Hold until both queues have been read once.
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
      // A second click would find the shutdown already claimed and fail.
      // `install` resolves once the save handshake starts, not when the app
      // exits, so the flag stays set on success — the app is on its way out.
      if (installing.current) return
      installing.current = true
      commands.install().catch((error: unknown) => {
        installing.current = false
        console.warn("[update] install failed", error)
        // The update is still downloaded unless it went missing; re-checking
        // returns it again either way.
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

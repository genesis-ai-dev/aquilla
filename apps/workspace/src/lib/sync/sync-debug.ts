// Sync debug logger. Gated on:
//   1. Vite dev mode (always on in `npm run dev`)
//   2. sessionStorage["codex.debug.sync"] === "1" (turn on in prod via console)
//
// Logs: effect lifecycle, provider status/sync/close/error events, idle
// disconnect transitions. Each line is prefixed with the connection's `_pk`
// so client logs correlate 1:1 with the worker's `setName` lines.

import type YProvider from "y-partyserver/provider"

export function isSyncDebugEnabled(): boolean {
  if (import.meta.env.DEV) return true
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem("codex.debug.sync") === "1"
  } catch {
    return false
  }
}

function ts(): string {
  const d = new Date()
  return d.toISOString().slice(11, 23) // HH:MM:SS.mmm
}

function log(label: string, pk: string, msg: string, ...rest: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(`[sync ${ts()}] ${label} pk=${pk} ${msg}`, ...rest)
}

interface CloseLike {
  code?: number
  reason?: string
  wasClean?: boolean
}

export interface SyncDebugAttach {
  detach: () => void
  logEffectRun: (deps: Record<string, unknown>) => void
  logEffectCleanup: (note?: string) => void
  logIdle: (state: "hidden" | "visible" | "disconnect-fired" | "reconnect") => void
}

export function attachSyncDebug(
  provider: YProvider,
  label: string
): SyncDebugAttach {
  if (!isSyncDebugEnabled()) {
    return {
      detach: () => {},
      logEffectRun: () => {},
      logEffectCleanup: () => {},
      logIdle: () => {},
    }
  }

  const pk = provider.id
  const startedAt = Date.now()
  log(label, pk, "attach", { url: (provider as { url?: string }).url })

  const onStatus = (e: { status: string }) => {
    log(label, pk, `status=${e.status}`, {
      wsconnected: provider.wsconnected,
      wsconnecting: provider.wsconnecting,
      synced: provider.synced,
      bcconnected: provider.bcconnected,
      reconnects: provider.wsUnsuccessfulReconnects,
      uptimeMs: Date.now() - startedAt,
    })
  }

  const onSync = (synced: boolean) => {
    log(label, pk, `sync=${synced}`, {
      uptimeMs: Date.now() - startedAt,
    })
  }

  const onClose = (event: CloseLike | null) => {
    log(label, pk, "connection-close", {
      code: event?.code,
      reason: event?.reason,
      wasClean: event?.wasClean,
      reconnects: provider.wsUnsuccessfulReconnects,
      uptimeMs: Date.now() - startedAt,
    })
  }

  const onError = (event: unknown) => {
    log(label, pk, "connection-error", {
      // The Event itself is mostly opaque; capture what we can.
      type: (event as { type?: string })?.type,
      reconnects: provider.wsUnsuccessfulReconnects,
    })
  }

  provider.on("status", onStatus)
  provider.on("sync", onSync)
  provider.on("connection-close", onClose)
  provider.on("connection-error", onError)

  return {
    detach: () => {
      provider.off("status", onStatus)
      provider.off("sync", onSync)
      provider.off("connection-close", onClose)
      provider.off("connection-error", onError)
      log(label, pk, "detach", { uptimeMs: Date.now() - startedAt })
    },
    logEffectRun: (deps) => log(label, pk, "effect run", deps),
    logEffectCleanup: (note) => log(label, pk, "effect cleanup", { note }),
    logIdle: (state) => log(label, pk, `idle:${state}`),
  }
}

// Standalone effect logger for the case where there is no provider yet
// (deps caused effect to short-circuit). Lets us see *why* useFileSync didn't
// instantiate a provider this render.
export function logEffectShortCircuit(
  label: string,
  deps: Record<string, unknown>
): void {
  if (!isSyncDebugEnabled()) return
  // eslint-disable-next-line no-console
  console.log(`[sync ${ts()}] ${label} pk=- effect short-circuit`, deps)
}

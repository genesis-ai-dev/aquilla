// Sync debug logger for the legacy provider path.
//
// AD-1 removes the file provider from production. This helper remains as a
// small compatibility surface for older imports while the project WebSocket
// owns live coordination.

interface LegacySyncDebugProvider {
  id: string
  wsconnected?: boolean
  wsconnecting?: boolean
  synced?: boolean
  bcconnected?: boolean
  wsUnsuccessfulReconnects?: number
  on(event: string, handler: (...args: unknown[]) => void): void
  off(event: string, handler: (...args: unknown[]) => void): void
}

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
  return d.toISOString().slice(11, 23)
}

function log(label: string, pk: string, msg: string, ...rest: unknown[]): void {
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
  provider: LegacySyncDebugProvider,
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
      type: (event as { type?: string })?.type,
      reconnects: provider.wsUnsuccessfulReconnects,
    })
  }

  provider.on("status", onStatus as (...args: unknown[]) => void)
  provider.on("sync", onSync as (...args: unknown[]) => void)
  provider.on("connection-close", onClose as (...args: unknown[]) => void)
  provider.on("connection-error", onError as (...args: unknown[]) => void)

  return {
    detach: () => {
      provider.off("status", onStatus as (...args: unknown[]) => void)
      provider.off("sync", onSync as (...args: unknown[]) => void)
      provider.off("connection-close", onClose as (...args: unknown[]) => void)
      provider.off("connection-error", onError as (...args: unknown[]) => void)
      log(label, pk, "detach", { uptimeMs: Date.now() - startedAt })
    },
    logEffectRun: (deps) => log(label, pk, "effect run", deps),
    logEffectCleanup: (note) => log(label, pk, "effect cleanup", { note }),
    logIdle: (state) => log(label, pk, `idle:${state}`),
  }
}

export function logEffectShortCircuit(
  label: string,
  deps: Record<string, unknown>
): void {
  if (!isSyncDebugEnabled()) return
  console.log(`[sync ${ts()}] ${label} pk=- effect short-circuit`, deps)
}

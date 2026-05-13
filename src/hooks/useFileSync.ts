// File-level sync hook backed by the codex sync-worker (y-partyserver DO + R2).

import { useEffect, useState, useMemo, useRef } from "react"
import * as Y from "yjs"
import type YProvider from "y-partyserver/provider"
import {
  createFileSyncProvider,
  destroyFileSyncProvider,
  type FileSyncProviderHandle,
} from "@/lib/sync/partyserver-provider"
import { displayNameFor } from "@/lib/sync/anonymous-name"
import { makeSyncTokenFetcher } from "@/lib/sync/sync-token"
import { attachSyncDebug, logEffectShortCircuit, type SyncDebugAttach } from "@/lib/sync/sync-debug"
import { patchProject } from "@/lib/store/project-index"
import type { FrontierSession } from "@/lib/frontier/types"
import type { SyncStatus } from "@/components/SyncStatusIndicator"

/** Awareness payload for a single connected peer in a file-sync room. */
export interface PeerState {
  /** Ephemeral client ID from y-partyserver awareness. */
  peerId: string
  username: string
  color: string
  currentFileId?: string
}

/**
 * Deterministic color from a peerId for avatar tinting. Same id maps to the
 * same color across reloads so peers stay visually stable.
 */
export function peerColor(peerId: string): string {
  let hash = 0
  for (let i = 0; i < peerId.length; i++) {
    hash = (hash << 5) - hash + peerId.charCodeAt(i)
    hash |= 0
  }
  const colors = [
    "#3b82f6", "#ef4444", "#22c55e", "#a855f7", "#f97316",
    "#14b8a6", "#eab308", "#ec4899", "#6366f1", "#84cc16",
  ]
  return colors[Math.abs(hash) % colors.length]
}

interface UseFileSyncOptions {
  doc: Y.Doc | null
  projectId: string | null
  fileId: string | null
  username: string
  enabled: boolean
  /** Active Frontier session. When null, the provider connects with no auth
   *  token — fine in dev mode, rejected in prod (editor keeps working via
   *  IndexedDB). */
  session: FrontierSession | null
  /** Human-readable project name — forwarded to /sync-token so the server can
   *  auto-register the project row on first use with something meaningful. */
  projectName?: string | null
  /** GitLab project ID when the project is GitLab-backed; enables the
   *  GitLab-permission fallback for other users later. */
  gitlabProjectId?: number | null
}

export function useFileSync(options: UseFileSyncOptions): {
  peers: PeerState[]
  connected: boolean
  provider: YProvider | null
  status: SyncStatus
} {
  const { doc, projectId, fileId, username, enabled, session, projectName, gitlabProjectId } = options
  const [peers, setPeers] = useState<PeerState[]>([])
  const [connected, setConnected] = useState(false)
  const [provider, setProviderState] = useState<YProvider | null>(null)
  const [isIdle, setIsIdle] = useState(false)

  const handleRef = useMemo(() => ({ current: null as FileSyncProviderHandle | null }), [])

  // Stash the current jwt in a ref so the token-fetcher closure always reads
  // the latest session without tearing down the provider on session swap.
  const jwtRef = useRef<string | null>(session?.jwt ?? null)
  useEffect(() => {
    jwtRef.current = session?.jwt ?? null
  }, [session])

  useEffect(() => {
    if (!enabled || !doc || !projectId || !fileId) {
      logEffectShortCircuit("useFileSync", { enabled, hasDoc: !!doc, projectId, fileId })
      setPeers([])
      setConnected(false)
      setProviderState(null)
      return
    }

    const getToken = makeSyncTokenFetcher(
      () => jwtRef.current,
      projectId,
      fileId,
      {
        projectName: projectName ?? undefined,
        gitlabProjectId: gitlabProjectId ?? undefined,
      },
      undefined,
      {
        onRole: (role) => {
          // Persist the authoritative role back to IDB so the Dashboard can
          // show owner-only actions without re-calling the server.
          void patchProject(projectId, (p) => ({
            ...p,
            syncRole: {
              level: role.level,
              name: role.name,
              source: role.source,
              fetchedAt: new Date().toISOString(),
            },
          }))
        },
      }
    )
    const handle = createFileSyncProvider(doc, projectId, fileId, getToken)
    handleRef.current = handle
    const { provider } = handle
    setProviderState(provider)

    const debug: SyncDebugAttach = attachSyncDebug(provider, "useFileSync")
    debug.logEffectRun({ projectId, fileId, clientID: provider.awareness.clientID })

    const selfClientId = String(provider.awareness.clientID)
    const selfState: PeerState = {
      peerId: selfClientId,
      username: displayNameFor(username, selfClientId),
      color: peerColor(selfClientId),
      currentFileId: fileId,
    }
    provider.awareness.setLocalState(selfState)

    function updatePeers() {
      const states: PeerState[] = []
      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId === provider.awareness.clientID) return
        if (!state) return
        const peerClientId = String(clientId)
        states.push({
          peerId: peerClientId,
          username: displayNameFor(state.username as string | undefined, peerClientId),
          color: (state.color as string) || peerColor(peerClientId),
          currentFileId: state.currentFileId as string | undefined,
        })
      })
      setPeers(states)
    }

    function updateConnected() {
      const anyProvider = provider as unknown as { wsconnected?: boolean }
      setConnected(Boolean(anyProvider.wsconnected))
    }

    provider.awareness.on("change", updatePeers)
    provider.on("status", updateConnected)
    provider.on("sync", updateConnected)
    updatePeers()
    updateConnected()

    return () => {
      debug.logEffectCleanup("teardown")
      debug.detach()
      provider.awareness.off("change", updatePeers)
      provider.off("status", updateConnected)
      provider.off("sync", updateConnected)
      destroyFileSyncProvider(handle)
      handleRef.current = null
      setProviderState(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, projectId, fileId, enabled])

  useEffect(() => {
    const handle = handleRef.current
    if (!handle) return
    const { provider } = handle
    const current = provider.awareness.getLocalState() || {}
    const selfClientId = String(provider.awareness.clientID)
    provider.awareness.setLocalState({
      ...current,
      username: displayNameFor(username, selfClientId),
      currentFileId: fileId,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, fileId])

  // Idle-disconnect: if the tab stays hidden for 5 minutes, tear down the WS
  // to let the DO hibernate (keeping it alive costs nothing while truly idle,
  // but once the browser throttles the tab we get unhelpful reconnect noise).
  // Reconnects automatically when the tab becomes visible again.
  useEffect(() => {
    if (!provider) return
    // Guard against non-browser contexts (tests running outside happy-dom/node).
    if (typeof document === "undefined") return

    const HIDDEN_IDLE_MS = 5 * 60 * 1000
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let idleDisconnected = false

    const debugLogIdle = (state: "hidden" | "visible" | "disconnect-fired" | "reconnect") => {
      // Lightweight inline call; attachSyncDebug instance lives in the
      // provider effect above, so we just write straight to console with the
      // same format if debug is on.
      if (import.meta.env.DEV ||
          (typeof sessionStorage !== "undefined" && sessionStorage.getItem("codex.debug.sync") === "1")) {
        // eslint-disable-next-line no-console
        console.log(`[sync ${new Date().toISOString().slice(11, 23)}] useFileSync pk=${provider.id} idle:${state}`, {
          visibility: typeof document !== "undefined" ? document.visibilityState : "unknown",
        })
      }
    }

    const disconnectIfStillHidden = () => {
      if (document.visibilityState === "hidden" && !idleDisconnected) {
        debugLogIdle("disconnect-fired")
        provider.disconnect()
        idleDisconnected = true
        setIsIdle(true)
      }
    }

    const onVisChange = () => {
      if (document.visibilityState === "hidden") {
        debugLogIdle("hidden")
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(disconnectIfStillHidden, HIDDEN_IDLE_MS)
      } else {
        debugLogIdle("visible")
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
        if (idleDisconnected) {
          debugLogIdle("reconnect")
          provider.connect()
          idleDisconnected = false
          setIsIdle(false)
        }
      }
    }

    document.addEventListener("visibilitychange", onVisChange)
    if (document.visibilityState === "hidden") {
      idleTimer = setTimeout(disconnectIfStillHidden, HIDDEN_IDLE_MS)
    }

    return () => {
      if (idleTimer) clearTimeout(idleTimer)
      document.removeEventListener("visibilitychange", onVisChange)
    }
  }, [provider])

  // Status derivation:
  //   disabled   — hook not running (no session, no project/file, or disabled)
  //   idle       — intentionally disconnected while the tab is hidden
  //   connecting — provider exists but WS hasn't completed the handshake yet;
  //                doubles as the "reconnecting" state since YProvider
  //                automatically backs off on failure
  //   live       — WS connected AND server acked sync
  const status: SyncStatus = !provider
    ? "disabled"
    : isIdle
      ? "idle"
      : connected
        ? "live"
        : "connecting"

  return { peers, connected, provider, status }
}

/**
 * Aquilla Tools (prototype): the project's installed tools, for the panel
 * (left dock) and inline (cell expansion) mounts. Provided once per project
 * workspace by ProjectWorkspaceRoute so deep editor rows can read it without
 * prop threading. Tool sources are fetched lazily, per mount.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { useParams } from "react-router-dom"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { FrontierSession } from "@/lib/frontier/types"
import { ensureFirstPartyTool, getTool, listTools, type FirstPartyEnsureResult, type ToolDetail, type ToolSummary } from "@/lib/tools/tools-api"
import { defaultEditorExtensionEnabled } from "@/lib/tools/default-editor-flag"
import { FIRST_PARTY_DEFAULT_EDITOR } from "../../../shared/tools/first-party/default-editor"
import type { ToolScope } from "../../../shared/tools/manifest"

export interface ToolsMountValue {
  projectId: string
  session: FrontierSession | null
  tools: ToolSummary[]
  refresh: () => void
  /** Cached tool detail (source) fetch. */
  loadTool: (toolId: string) => Promise<ToolDetail>
  /** Extensions pinned to the editor bar (per user + project). */
  pinned: string[]
  togglePin: (toolId: string) => void
  /** The extension open in the side panel (per user + project). */
  dockSelection: string | null
  setDockSelection: (toolId: string | null) => void
  /** Bumps whenever something asks for the side panel to open. */
  panelRequestSeq: number
  openInPanel: (toolId: string) => void
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  /** The first-party default editor extension's id, when it is the default
   *  (flag on, installed, not removed). */
  defaultEditorId: string | null
  /** Scopes the first-party editor was auto-granted for this user on this
   *  open (shown on the editor bar; empty once acknowledged/revisited). */
  autoGranted: ToolScope[]
  /** The first-party default editor is enabled (flag) for this browser. */
  defaultEditorEnabled: boolean
  /** The project's extensions (and the first-party install) have loaded. */
  toolsReady: boolean
}

interface ExtensionPrefs {
  pinned: string[]
  dock: string | null
}

function prefsKey(username: string, projectId: string): string {
  return `aquilla.extensions.prefs.v1:${username}:${projectId}`
}

function readPrefs(username: string, projectId: string): ExtensionPrefs {
  try {
    const raw = window.localStorage.getItem(prefsKey(username, projectId))
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== "object") return { pinned: [], dock: null }
    const o = parsed as Record<string, unknown>
    return {
      pinned: Array.isArray(o.pinned) ? o.pinned.filter((x): x is string => typeof x === "string") : [],
      dock: typeof o.dock === "string" ? o.dock : null,
    }
  } catch {
    return { pinned: [], dock: null }
  }
}

function writePrefs(username: string, projectId: string, prefs: ExtensionPrefs): void {
  try {
    window.localStorage.setItem(prefsKey(username, projectId), JSON.stringify(prefs))
  } catch {
    // private mode / quota — prefs still apply for this session
  }
}

const ToolsMountContext = createContext<ToolsMountValue | null>(null)

export function ToolsMountProvider({ children }: { children: ReactNode }) {
  const { id: projectId = "" } = useParams<{ id: string }>()
  const { session } = useFrontierSession()
  const [tools, setTools] = useState<ToolSummary[]>([])
  const [version, setVersion] = useState(0)
  const [details] = useState(() => new Map<string, Promise<ToolDetail>>())
  const jwt = session?.jwt ?? null
  const username = session?.username ?? ""
  const prefsId = `${username}:${projectId}`
  const [prefs, setPrefs] = useState<ExtensionPrefs>(() => readPrefs(username, projectId))
  const [prefsFor, setPrefsFor] = useState(prefsId)
  if (prefsFor !== prefsId) {
    setPrefsFor(prefsId)
    setPrefs(readPrefs(username, projectId))
  }
  const [panelRequestSeq, setPanelRequestSeq] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const updatePrefs = useCallback(
    (fn: (p: ExtensionPrefs) => ExtensionPrefs) => {
      setPrefs((prev) => {
        const next = fn(prev)
        writePrefs(username, projectId, next)
        return next
      })
    },
    [username, projectId],
  )
  const togglePin = useCallback(
    (toolId: string) =>
      updatePrefs((p) => ({ ...p, pinned: p.pinned.includes(toolId) ? p.pinned.filter((x) => x !== toolId) : [...p.pinned, toolId] })),
    [updatePrefs],
  )
  const setDockSelection = useCallback((toolId: string | null) => updatePrefs((p) => ({ ...p, dock: toolId })), [updatePrefs])
  const openInPanel = useCallback(
    (toolId: string) => {
      setDockSelection(toolId)
      setPanelRequestSeq((n) => n + 1)
    },
    [setDockSelection],
  )

  const [autoGranted, setAutoGranted] = useState<ToolScope[]>([])
  const [defaultEditorOn] = useState(() => defaultEditorExtensionEnabled())
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  useEffect(() => {
    if (!jwt || !projectId) return
    let cancelled = false
    // First-party default editor: the server installs (or upgrades) it from
    // the repo's reviewed source. Best-effort — a failure leaves the built-in
    // editor as the default, never blocks the list. Runs IN PARALLEL with the
    // list (one round trip to first paint), and its answer carries the
    // editor's source, which seeds the detail cache so mounting it needs no
    // further fetch.
    const ensured: Promise<FirstPartyEnsureResult | null> = defaultEditorOn && version === 0
      ? ensureFirstPartyTool(jwt, projectId, FIRST_PARTY_DEFAULT_EDITOR).catch((err: unknown) => {
          console.warn("[extensions] first-party editor install failed:", err)
          return null
        })
      : Promise.resolve(null)
    const listed = listTools(jwt, projectId).catch(() => null)
    void Promise.all([ensured, listed]).then(([res, list]) => {
      if (cancelled) return
      let next = list ?? []
      const fresh = res?.tool ?? null
      if (fresh) {
        details.set(`${fresh.id}@${fresh.currentVersion}`, Promise.resolve(fresh))
        // The list may have been read before this ensure installed/upgraded it.
        const { source: _source, ...summary } = fresh
        next = next.some((t) => t.id === fresh.id) ? next.map((t) => (t.id === fresh.id ? summary : t)) : [summary, ...next]
      }
      if (res && res.autoGranted.length > 0) setAutoGranted(res.autoGranted)
      // Tools are an optional surface: a failed list never blocks the editor.
      setTools(next)
      setLoadedFor(projectId)
    })
    return () => {
      cancelled = true
    }
  }, [jwt, projectId, version, defaultEditorOn, details])
  const toolsReady = loadedFor === projectId

  const refresh = useCallback(() => {
    details.clear()
    setVersion((v) => v + 1)
  }, [details])

  const loadTool = useCallback(
    (toolId: string) => {
      if (!jwt) return Promise.reject(new Error("not signed in"))
      const summary = tools.find((t) => t.id === toolId)
      const key = `${toolId}@${summary?.currentVersion ?? "?"}`
      let p = details.get(key)
      if (!p) {
        p = getTool(jwt, projectId, toolId)
        details.set(key, p)
        p.catch(() => details.delete(key))
      }
      return p
    },
    [jwt, projectId, tools, details],
  )

  const defaultEditorId = defaultEditorOn
    ? (tools.find((t) => t.firstParty === FIRST_PARTY_DEFAULT_EDITOR && t.manifest.mounts.includes("editor"))?.id ?? null)
    : null

  const value = useMemo(
    () => ({
      projectId,
      session: session ?? null,
      tools,
      refresh,
      loadTool,
      pinned: prefs.pinned,
      togglePin,
      dockSelection: prefs.dock,
      setDockSelection,
      panelRequestSeq,
      openInPanel,
      paletteOpen,
      setPaletteOpen,
      defaultEditorId,
      autoGranted,
      defaultEditorEnabled: defaultEditorOn,
      toolsReady,
    }),
    [projectId, session, tools, refresh, loadTool, prefs, togglePin, setDockSelection, panelRequestSeq, openInPanel, paletteOpen, defaultEditorId, autoGranted, defaultEditorOn, toolsReady],
  )
  return <ToolsMountContext.Provider value={value}>{children}</ToolsMountContext.Provider>
}

/** Null outside a project workspace (or in tests that render rows alone). */
export function useToolsMount(): ToolsMountValue | null {
  return useContext(ToolsMountContext)
}

/** Load one tool's detail for mounting. */
export function useMountedTool(toolId: string | null): { tool: ToolDetail | null; error: string | null } {
  const ctx = useToolsMount()
  const [state, setState] = useState<{ id: string | null; tool: ToolDetail | null; error: string | null }>({
    id: null,
    tool: null,
    error: null,
  })
  useEffect(() => {
    if (!ctx || !toolId) return
    let cancelled = false
    ctx
      .loadTool(toolId)
      .then((tool) => {
        if (!cancelled) setState({ id: toolId, tool, error: null })
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ id: toolId, tool: null, error: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [ctx, toolId])
  return state.id === toolId ? { tool: state.tool, error: state.error } : { tool: null, error: null }
}

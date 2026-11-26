/**
 * Aquilla Tools (prototype): the project's installed tools, for the panel
 * (left dock) and inline (cell expansion) mounts. Provided once per project
 * workspace by ProjectWorkspaceRoute so deep editor rows can read it without
 * prop threading. Tool sources are fetched lazily, per mount.
 */

import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useParams } from "react-router-dom"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { FrontierSession } from "@/lib/frontier/types"
import { ensureFirstPartyTool, getTool, listTools, type FirstPartyEnsureResult, type ToolDetail, type ToolSummary } from "@/lib/tools/tools-api"
import { FIRST_PARTY_DOOR43_IMPORTER } from "../../../shared/tools/first-party/door43-importer"
import { useProject } from "@/hooks/useProject"
import { useSmartExtensionsEnabled } from "@/lib/tools/smart-extensions-enabled"
import type { HeadlessJob, HeadlessJobHooks, HeadlessOutcome } from "./HeadlessRuns"
import { makeAudioSyncTokenFetcher } from "@/lib/audio/sync-token-fetcher"
import { fetchProjectFiles } from "@/lib/sync/cells-read"
import type { FileImportProvenance } from "../../../shared/tools/file-extension"
import { dueOnOpenActions, markOnOpenRun } from "@/lib/tools/on-open-actions"
import {
  NativeEditorStore,
  readExtensionColumnPrefs,
  writeExtensionColumnPrefs,
  type ExtensionColumnPref,
} from "@/lib/tools/native-editor-store"

export interface ActionRunTarget {
  cell?: { fileId: string; cellId: string; ref?: string | null }
  selection?: { fileId: string; cellId: string; side: "source" | "target"; text: string }
}

// AQU-2093: the runner brings zip, the rich-text editor and the HTML sanitiser
// with it, so it loads with the first headless job, not with every page.
const HeadlessRuns = lazy(() => import("./HeadlessRuns").then((m) => ({ default: m.HeadlessRuns })))

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
  /** The project's extensions (and first-party installs) have loaded. */
  toolsReady: boolean
  /** apiRev 7/8: run a manifest action headless (optionally targeting a cell or text selection). */
  runAction: (toolId: string, actionId: string, trigger?: "click" | "open" | "cell" | "selection", target?: ActionRunTarget) => void
  /** apiRev 8: bridge store connecting extensions to Aquilla's real native EditorTable. */
  nativeEditor: NativeEditorStore
  /** apiRev 8: per-user visibility overrides for manifest.columns (`${toolId}:${columnId}`). */
  columnPrefs: Record<string, ExtensionColumnPref>
  setColumnPref: (key: string, pref: ExtensionColumnPref) => void
  /** apiRev 7: run a manifest export headless; settles once files were delivered. */
  runExport: (toolId: string, exportId: string, fileIds: string[], lane: string) => Promise<HeadlessOutcome>
  /** AQU-1937: run an import contribution headless (run, or refresh files). */
  runImport: (
    toolId: string,
    importerId: string,
    options: Record<string, unknown>,
    opts?: { phase?: "run" | "refresh"; fileIds?: string[] } & HeadlessJobHooks,
  ) => { key: string; done: Promise<HeadlessOutcome> }
  /** AQU-1937: ask an importer for a dynamic field's choices. Answers are
   *  cached for the session (per tool version, field and options); `fresh`
   *  skips the cache (Retry). */
  importChoices: (
    toolId: string,
    importerId: string,
    field: string,
    options: Record<string, unknown>,
    opts?: { fresh?: boolean } & HeadlessJobHooks,
  ) => Promise<HeadlessOutcome>
  /** Stop a running headless job (import cancel). */
  cancelJob: (key: string) => void
  /** AQU-1937: files an import contribution wrote (fileId → provenance). */
  fileImports: ReadonlyMap<string, FileImportProvenance>
  /** Re-run the importer that wrote this file, with its stored options. */
  refreshFile: (fileId: string) => Promise<HeadlessOutcome>
  /** apiRev 7: headless jobs running now. */
  runningJobs: number
  /** AQU-1937: the project's Smart Extensions switch (null while unknown). */
  extensionsEnabled: boolean | null
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
  const [columnPrefs, setColumnPrefs] = useState<Record<string, ExtensionColumnPref>>(() => readExtensionColumnPrefs(username, projectId))
  const [prefsFor, setPrefsFor] = useState(prefsId)
  if (prefsFor !== prefsId) {
    setPrefsFor(prefsId)
    setPrefs(readPrefs(username, projectId))
    setColumnPrefs(readExtensionColumnPrefs(username, projectId))
  }
  // apiRev 8: one external store per project for active-cell sync, reveal,
  // declarative row annotations, and extension column cells.
  const [nativeEditorState, setNativeEditorState] = useState(() => ({ projectId, store: new NativeEditorStore() }))
  if (nativeEditorState.projectId !== projectId) {
    setNativeEditorState({ projectId, store: new NativeEditorStore() })
  }
  const nativeEditor = nativeEditorState.store
  const setColumnPref = useCallback(
    (key: string, pref: ExtensionColumnPref) => {
      setColumnPrefs((prev) => {
        const next = { ...prev, [key]: pref }
        writeExtensionColumnPrefs(username, projectId, next)
        return next
      })
    },
    [username, projectId],
  )
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

  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  // AQU-1937: nothing about extensions loads (not even the first-party
  // install) unless the project has Smart Extensions switched on.
  const extensionsEnabled = useSmartExtensionsEnabled(jwt, projectId)
  useEffect(() => {
    if (!jwt || !projectId || extensionsEnabled === null) return
    if (!extensionsEnabled) {
      setTools([])
      setLoadedFor(projectId)
      return
    }
    let cancelled = false
    // AQU-1937: the first-party Door43 importer (Import → "Door43 resources"),
    // installed by the server from the repo's reviewed source. Its auto-grant
    // (read:web for git.door43.org, write:files, write:data) is the user's own;
    // the role ceiling still applies.
    const ensuredDoor43: Promise<FirstPartyEnsureResult | null> = version === 0
      ? ensureFirstPartyTool(jwt, projectId, FIRST_PARTY_DOOR43_IMPORTER).catch((err: unknown) => {
          console.warn("[extensions] first-party Door43 importer install failed:", err)
          return null
        })
      : Promise.resolve(null)
    // Listed AFTER that install, so a fresh install is in the first list.
    const listed = ensuredDoor43.then(() => listTools(jwt, projectId).catch(() => null))
    void listed.then((list) => {
      if (cancelled) return
      // Tools are an optional surface: a failed list never blocks the editor.
      setTools(list ?? [])
      setLoadedFor(projectId)
    })
    return () => {
      cancelled = true
    }
  }, [jwt, projectId, version, details, extensionsEnabled])
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

  // apiRev 7: headless actions and exports.
  const { project: projectRecord, roleLevel } = useProject(projectId)
  const [jobs, setJobs] = useState<HeadlessJob[]>([])
  const finishJob = useCallback((key: string) => setJobs((prev) => prev.filter((j) => j.key !== key)), [])
  // A click can arrive before this provider's own tool list has the tool
  // (the extensions page lists tools with its own, faster read; a just-installed
  // tool): the run waits for the list instead of being silently dropped.
  const pendingActions = useRef<Array<{ toolId: string; actionId: string; trigger: "click" | "open" | "cell" | "selection"; target?: ActionRunTarget }>>([])
  const runAction = useCallback(
    (toolId: string, actionId: string, trigger: "click" | "open" | "cell" | "selection" = "click", target?: ActionRunTarget) => {
      const tool = tools.find((x) => x.id === toolId)
      const action = tool?.manifest.actions?.find((a) => a.id === actionId)
      if (!tool || !action) {
        const first = pendingActions.current.length === 0
        pendingActions.current.push({ toolId, actionId, trigger, ...(target ? { target } : {}) })
        // Loaded but missing: it was installed after the last list — read it again (once).
        if (first && toolsReady) refresh()
        return
      }
      setJobs((prev) =>
        // Cell/selection runs may fire back-to-back on different cells; deduplicate bar/open runs only.
        !target && prev.some((j) => j.toolId === toolId && j.actionId === actionId)
          ? prev
          : [
              ...prev,
              {
                key: `${toolId}:${actionId}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
                toolId,
                kind: "action",
                label: action.label,
                actionId,
                trigger,
                ...(target?.cell ? { cell: target.cell } : {}),
                ...(target?.selection ? { selection: target.selection } : {}),
              },
            ],
      )
    },
    [tools, toolsReady, refresh],
  )
  useEffect(() => {
    if (pendingActions.current.length === 0 || !toolsReady) return
    const waiting = pendingActions.current
    pendingActions.current = []
    for (const p of waiting) {
      const known = tools.some((t) => t.id === p.toolId && t.manifest.actions?.some((x) => x.id === p.actionId))
      if (known) runAction(p.toolId, p.actionId, p.trigger, p.target)
    }
  }, [tools, toolsReady, runAction])
  const runExport = useCallback(
    (toolId: string, exportId: string, fileIds: string[], lane: string) =>
      new Promise<HeadlessOutcome>((resolve) => {
        const tool = tools.find((x) => x.id === toolId)
        const format = tool?.manifest.exports?.find((x) => x.id === exportId)
        if (!tool || !format) {
          resolve({ ok: false, error: "unknown export" })
          return
        }
        setJobs((prev) => [
          ...prev,
          { key: `${toolId}:export:${exportId}:${Date.now()}`, toolId, kind: "export", label: format.label, exportId, fileIds, lane, extension: format.extension, settle: resolve },
        ])
      }),
    [tools],
  )
  // AQU-1937: import contributions — the same headless runner as exports.
  const [fileImports, setFileImports] = useState<ReadonlyMap<string, FileImportProvenance>>(new Map())
  const [importsVersion, setImportsVersion] = useState(0)
  const runImport = useCallback<ToolsMountValue["runImport"]>(
    (toolId, importerId, options, opts = {}) => {
      const tool = tools.find((x) => x.id === toolId)
      const importer = tool?.manifest.importers?.find((x) => x.id === importerId)
      const key = `${toolId}:import:${importerId}:${Date.now()}`
      const done = new Promise<HeadlessOutcome>((resolve) => {
        if (!tool || !importer) {
          resolve({ ok: false, error: "unknown importer" })
          return
        }
        setJobs((prev) => [
          ...prev,
          {
            key, toolId, kind: "import", label: importer.label, importerId, phase: opts.phase ?? "run", options,
            ...(opts.fileIds ? { fileIds: opts.fileIds } : {}),
            ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
            ...(opts.onPrompt ? { onPrompt: opts.onPrompt } : {}),
            settle: (outcome) => {
              resolve(outcome)
              setImportsVersion((n) => n + 1)
            },
          },
        ])
      })
      return { key, done }
    },
    [tools],
  )
  // Session cache of choices answers: reopening Import (or going back to a
  // language already asked for) is instant instead of another catalog read.
  const choicesCache = useRef(new Map<string, { value: string; label: string; group?: string }[]>())
  const importChoices = useCallback<ToolsMountValue["importChoices"]>(
    (toolId, importerId, field, options, opts = {}) =>
      new Promise<HeadlessOutcome>((resolve) => {
        const tool = tools.find((x) => x.id === toolId)
        const importer = tool?.manifest.importers?.find((x) => x.id === importerId)
        if (!tool || !importer) {
          resolve({ ok: false, error: "unknown importer" })
          return
        }
        const cacheKey = JSON.stringify([toolId, tool.currentVersion, importerId, field, options])
        const cached = opts.fresh ? undefined : choicesCache.current.get(cacheKey)
        if (cached) {
          resolve({ ok: true, choices: cached })
          return
        }
        const key = `${toolId}:choices:${field}:${Date.now()}`
        opts.onStart?.(key)
        setJobs((prev) => [
          ...prev,
          {
            key, toolId, kind: "import", label: importer.label, importerId, phase: "choices", options, field,
            ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
            ...(opts.onPrompt ? { onPrompt: opts.onPrompt } : {}),
            settle: (outcome) => {
              if (outcome.ok && outcome.choices && outcome.choices.length > 0) choicesCache.current.set(cacheKey, outcome.choices)
              resolve(outcome)
            },
          },
        ])
      }),
    [tools],
  )
  const cancelJob = useCallback((key: string) => setJobs((prev) => prev.filter((j) => j.key !== key)), [])
  // Which files an import contribution wrote (for "Refresh from source").
  useEffect(() => {
    if (!session || !projectId || extensionsEnabled !== true) return
    let alive = true
    const tokenFor = makeAudioSyncTokenFetcher(() => session)
    void tokenFor(projectId, "any")
      .then((token) => (token ? fetchProjectFiles(projectId, token) : []))
      .then((files) => {
        if (!alive) return
        const next = new Map<string, FileImportProvenance>()
        for (const f of files) if (f.extension?.import && !f.deletedAt) next.set(f.fileId, f.extension.import)
        setFileImports(next)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [session, projectId, extensionsEnabled, importsVersion])
  const refreshFile = useCallback(
    async (fileId: string): Promise<HeadlessOutcome> => {
      const prov = fileImports.get(fileId)
      if (!prov) return { ok: false, error: "this file was not written by an extension importer" }
      return runImport(prov.tool, prov.importer, prov.options, { phase: "refresh", fileIds: [fileId] }).done
    },
    [fileImports, runImport],
  )
  // "Check on project open": once the list has loaded, at most once a day per
  // user, and only for actions whose extension already holds every scope it
  // declares (an on-open run must never surprise anyone with a prompt).
  const [openChecked, setOpenChecked] = useState<string | null>(null)
  useEffect(() => {
    if (loadedFor !== projectId || openChecked === projectId || roleLevel == null || !username) return
    setOpenChecked(projectId)
    for (const due of dueOnOpenActions(tools, { username, projectId, roleLevel, now: Date.now() })) {
      markOnOpenRun({ username, projectId, toolId: due.toolId, actionId: due.actionId, now: Date.now() })
      runAction(due.toolId, due.actionId, "open")
    }
  }, [loadedFor, projectId, openChecked, roleLevel, username, tools, runAction])

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
      toolsReady,
      runAction,
      nativeEditor,
      columnPrefs,
      setColumnPref,
      runExport,
      runningJobs: jobs.length,
      extensionsEnabled,
      runImport,
      importChoices,
      cancelJob,
      fileImports,
      refreshFile,
    }),
    [projectId, session, tools, refresh, loadTool, prefs, togglePin, setDockSelection, panelRequestSeq, openInPanel, paletteOpen, toolsReady, runAction, nativeEditor, columnPrefs, setColumnPref, runExport, jobs.length, extensionsEnabled, runImport, importChoices, cancelJob, fileImports, refreshFile],
  )
  // Mounted from the first job on and kept, so tools it has loaded stay loaded.
  const [runnerNeeded, setRunnerNeeded] = useState(false)
  if (jobs.length > 0 && !runnerNeeded) setRunnerNeeded(true)

  return (
    <ToolsMountContext.Provider value={value}>
      {children}
      {runnerNeeded && (
        <Suspense fallback={null}>
          <HeadlessRuns
            jobs={jobs}
            loadTool={loadTool}
            project={projectRecord ? { id: projectRecord.id, name: projectRecord.name } : null}
            session={session ?? null}
            roleLevel={roleLevel ?? null}
            onFinish={finishJob}
          />
        </Suspense>
      )}
    </ToolsMountContext.Provider>
  )
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

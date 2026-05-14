import { useCallback, useEffect, useMemo, useState } from "react"

const STORAGE_PREFIX = "codex:tabs:"

export interface WorkspaceTab {
  id: string
  fileId: string
  sectionLabel?: string
}

interface PersistedState {
  tabs: WorkspaceTab[]
  /** Last file the user actually had open. Survives navigation to Project
   *  subpages (Rules/Comments/Snapshots/...) so returning to the workspace
   *  re-opens the same file instead of dropping to an empty view (#38). */
  lastActiveFileId?: string
}

interface UseWorkspaceTabsArgs {
  projectId: string
  fileIds: readonly string[]
  activeFileId: string | null
  setActiveFileId: (fileId: string | null) => void
}

export interface UseWorkspaceTabsReturn {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  openFile: (fileId: string, opts?: { sectionLabel?: string }) => void
  closeTab: (tabId: string) => void
  activateTab: (tabId: string) => void
}

function readState(projectId: string): PersistedState {
  if (typeof window === "undefined") return { tabs: [] }
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + projectId)
    if (!raw) return { tabs: [] }
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    if (!parsed || !Array.isArray(parsed.tabs)) return { tabs: [] }
    const cleaned = parsed.tabs
      .filter(
        (t): t is WorkspaceTab =>
          !!t && typeof t.id === "string" && typeof t.fileId === "string",
      )
      .map((t) => ({
        id: t.id,
        fileId: t.fileId,
        sectionLabel: typeof t.sectionLabel === "string" ? t.sectionLabel : undefined,
      }))
    const lastActiveFileId =
      typeof parsed.lastActiveFileId === "string" ? parsed.lastActiveFileId : undefined
    return { tabs: cleaned, lastActiveFileId }
  } catch {
    return { tabs: [] }
  }
}

function writeState(projectId: string, state: PersistedState): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify(state))
  } catch {
    // localStorage full / disabled — non-fatal, tabs just won't persist.
  }
}

/** Read the most-recently-active file id for a project. Free function so
 *  callers (ProjectWorkspace) can consult it during render to decide whether
 *  to restore a file on mount, without taking a dependency on this hook's
 *  state. Writes are co-located inside useWorkspaceTabs's persist effect. */
export function readLastActiveFileId(projectId: string): string | null {
  return readState(projectId).lastActiveFileId ?? null
}

function newTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function useWorkspaceTabs({
  projectId,
  fileIds,
  activeFileId,
  setActiveFileId,
}: UseWorkspaceTabsArgs): UseWorkspaceTabsReturn {
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() => readState(projectId).tabs)

  // Reload from storage when the project changes.
  useEffect(() => {
    setTabs(readState(projectId).tabs)
  }, [projectId])

  // Prune tabs whose file no longer exists in the project.
  useEffect(() => {
    const existing = new Set(fileIds)
    setTabs((prev) => {
      const next = prev.filter((t) => existing.has(t.fileId))
      return next.length === prev.length ? prev : next
    })
  }, [fileIds])

  // When the URL points at a file, ensure it has a tab.
  useEffect(() => {
    if (!activeFileId) return
    setTabs((prev) => {
      if (prev.some((t) => t.fileId === activeFileId)) return prev
      return [...prev, { id: newTabId(), fileId: activeFileId }]
    })
  }, [activeFileId])

  // Persist tabs + the most recent activeFileId. Co-locating the write keeps
  // a single storage key per project and ensures readLastActiveFileId (#38
  // restore-on-subpage-return) sees fresh data.
  useEffect(() => {
    writeState(projectId, {
      tabs,
      lastActiveFileId: activeFileId ?? undefined,
    })
  }, [projectId, tabs, activeFileId])

  const openFile = useCallback(
    (fileId: string, opts?: { sectionLabel?: string }) => {
      setTabs((prev) => {
        const existing = prev.find((t) => t.fileId === fileId)
        if (existing) {
          if (opts?.sectionLabel && existing.sectionLabel !== opts.sectionLabel) {
            return prev.map((t) =>
              t.id === existing.id ? { ...t, sectionLabel: opts.sectionLabel } : t,
            )
          }
          return prev
        }
        return [...prev, { id: newTabId(), fileId, sectionLabel: opts?.sectionLabel }]
      })
      setActiveFileId(fileId)
    },
    [setActiveFileId],
  )

  const activateTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const target = prev.find((t) => t.id === tabId)
        if (target) setActiveFileId(target.fileId)
        return prev
      })
    },
    [setActiveFileId],
  )

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === tabId)
        if (idx < 0) return prev
        const closing = prev[idx]
        const next = prev.filter((t) => t.id !== tabId)
        if (closing.fileId === activeFileId) {
          const neighbor = next[idx - 1] ?? next[idx] ?? null
          setActiveFileId(neighbor?.fileId ?? null)
          // Closing the last tab is an explicit "I'm done with files" gesture;
          // clear the sticky lastActiveFileId in storage so the restore-on-
          // subpage-return logic (#38) doesn't fight the close.
          if (!neighbor) {
            writeState(projectId, { tabs: next, lastActiveFileId: undefined })
          }
        }
        return next
      })
    },
    [activeFileId, projectId, setActiveFileId],
  )

  const activeTabId = useMemo(
    () => tabs.find((t) => t.fileId === activeFileId)?.id ?? null,
    [tabs, activeFileId],
  )

  return { tabs, activeTabId, openFile, closeTab, activateTab }
}

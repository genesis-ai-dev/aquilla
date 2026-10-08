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
import { getTool, listTools, type ToolDetail, type ToolSummary } from "@/lib/tools/tools-api"

export interface ToolsMountValue {
  projectId: string
  session: FrontierSession | null
  tools: ToolSummary[]
  refresh: () => void
  /** Cached tool detail (source) fetch. */
  loadTool: (toolId: string) => Promise<ToolDetail>
}

const ToolsMountContext = createContext<ToolsMountValue | null>(null)

export function ToolsMountProvider({ children }: { children: ReactNode }) {
  const { id: projectId = "" } = useParams<{ id: string }>()
  const { session } = useFrontierSession()
  const [tools, setTools] = useState<ToolSummary[]>([])
  const [version, setVersion] = useState(0)
  const [details] = useState(() => new Map<string, Promise<ToolDetail>>())
  const jwt = session?.jwt ?? null

  useEffect(() => {
    if (!jwt || !projectId) return
    let cancelled = false
    listTools(jwt, projectId)
      .then((next) => {
        if (!cancelled) setTools(next)
      })
      .catch(() => {
        // Tools are an optional surface: a failed list never blocks the editor.
      })
    return () => {
      cancelled = true
    }
  }, [jwt, projectId, version])

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

  const value = useMemo(
    () => ({ projectId, session: session ?? null, tools, refresh, loadTool }),
    [projectId, session, tools, refresh, loadTool],
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

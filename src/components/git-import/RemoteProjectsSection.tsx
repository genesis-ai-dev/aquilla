import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { ChevronRight, GitBranch, Loader2, Download, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useStreamingFrontierProjects } from "@/hooks/useStreamingFrontierProjects"
import { importFromGitRepo } from "@/lib/importer/git-importer"
import type { FrontierSession, GitlabProject } from "@/lib/frontier/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"

interface Props {
  session: FrontierSession
  localProjects: ProjectRecord[]
  onImported: (project: ProjectRecord) => void
}

type ImportState =
  | { kind: "idle" }
  | { kind: "running"; phase: string; done: number; total: number; label: string }
  | { kind: "done" }
  | { kind: "error"; message: string }

export function RemoteProjectsSection({ session, localProjects, onImported }: Props) {
  const { projects, loading, error } = useStreamingFrontierProjects(session)
  const [filter, setFilter] = useState("")
  const [imports, setImports] = useState<Record<number, ImportState>>({})
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  const navigate = useNavigate()

  // Map: gitlabProjectId -> local project (so we know what's already imported)
  const importedById = useMemo(() => {
    const m = new Map<number, ProjectRecord>()
    for (const p of localProjects) {
      if (p.origin?.kind === "git") m.set(p.origin.gitlabProjectId, p)
    }
    return m
  }, [localProjects])

  const grouped = useMemo(() => groupByNamespace(projects, filter), [projects, filter])

  // Auto-open groups when filtering so matches stay visible.
  const lastFilter = useRef("")
  useEffect(() => {
    if (filter && filter !== lastFilter.current) {
      const next: Record<string, boolean> = {}
      for (const path of grouped.order) next[path] = true
      setOpenGroups(next)
    }
    lastFilter.current = filter
  }, [filter, grouped.order])

  async function handleImport(p: GitlabProject) {
    setImports(s => ({ ...s, [p.id]: { kind: "running", phase: "clone", done: 0, total: 1, label: p.name } }))
    try {
      const imported = await importFromGitRepo({
        session, project: p,
        onPhase: (phase, done, total, label) =>
          setImports(s => ({ ...s, [p.id]: { kind: "running", phase, done, total, label } })),
      })
      setImports(s => ({ ...s, [p.id]: { kind: "done" } }))
      onImported(imported.project)
    } catch (e) {
      setImports(s => ({ ...s, [p.id]: { kind: "error", message: e instanceof Error ? e.message : String(e) } }))
    }
  }

  if (error) {
    return (
      <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">From Frontier</h2>
        <p className="text-sm text-destructive">{error}</p>
      </section>
    )
  }

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          From Frontier ({projects.length}{loading ? "…" : ""})
        </h2>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <Input
          placeholder="Filter by name or namespace…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="ml-auto h-8 max-w-xs"
        />
      </div>

      {projects.length === 0 && !loading ? (
        <p className="text-sm text-muted-foreground">No projects found.</p>
      ) : (
        <div className="space-y-1">
          {grouped.order.map(path => {
            const items = grouped.byPath[path]
            const isOpen = openGroups[path] ?? false
            return (
              <div key={path} className="rounded border">
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
                  onClick={() => setOpenGroups(s => ({ ...s, [path]: !isOpen }))}
                >
                  <ChevronRight className={cn("h-4 w-4 transition-transform", isOpen && "rotate-90")} />
                  <span className="text-sm font-medium">{path || "(root)"}</span>
                  <span className="text-xs text-muted-foreground">{items.length}</span>
                </button>
                {isOpen && (
                  <ul className="divide-y border-t">
                    {items.map(p => {
                      const local = importedById.get(p.id)
                      const state = imports[p.id] ?? { kind: "idle" as const }
                      return (
                        <li key={p.id} className="flex items-center gap-2 px-3 py-2">
                          <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm">{p.name}</p>
                            {p.description && (
                              <p className="truncate text-xs text-muted-foreground">{p.description}</p>
                            )}
                          </div>
                          <RowAction
                            local={local}
                            state={state}
                            onImport={() => handleImport(p)}
                            onOpen={() => local && navigate(`/project/${local.id}`)}
                          />
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function RowAction({
  local, state, onImport, onOpen,
}: {
  local: ProjectRecord | undefined
  state: ImportState
  onImport: () => void
  onOpen: () => void
}) {
  if (state.kind === "running") {
    const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="w-16 truncate">{state.phase}</span>
        <span className="tabular-nums w-10 text-right">{pct}%</span>
      </div>
    )
  }
  if (state.kind === "error") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-destructive max-w-[200px] truncate" title={state.message}>{state.message}</span>
        <Button size="sm" variant="outline" onClick={onImport}>Retry</Button>
      </div>
    )
  }
  if (local || state.kind === "done") {
    return (
      <Button size="sm" variant="ghost" onClick={onOpen}>
        <Check className="h-3.5 w-3.5 mr-1 text-green-600" /> Open
      </Button>
    )
  }
  return (
    <Button size="sm" variant="outline" onClick={onImport}>
      <Download className="h-3.5 w-3.5 mr-1" /> Import
    </Button>
  )
}

function groupByNamespace(
  projects: GitlabProject[], filter: string
): { order: string[]; byPath: Record<string, GitlabProject[]> } {
  const q = filter.trim().toLowerCase()
  const byPath: Record<string, GitlabProject[]> = {}
  for (const p of projects) {
    if (q && !p.path_with_namespace.toLowerCase().includes(q) &&
        !(p.description ?? "").toLowerCase().includes(q)) continue
    const parts = p.path_with_namespace.split("/")
    parts.pop() // drop project name
    const groupPath = parts.join("/")
    ;(byPath[groupPath] ??= []).push(p)
  }
  for (const arr of Object.values(byPath)) {
    arr.sort((a, b) => a.name.localeCompare(b.name))
  }
  const order = Object.keys(byPath).sort()
  return { order, byPath }
}

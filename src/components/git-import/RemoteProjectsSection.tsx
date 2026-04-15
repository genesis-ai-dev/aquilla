import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, useQueries } from "@tanstack/react-query"
import { ChevronRight, GitBranch, Loader2, Download, Check, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { listGroups, listAllGroupProjects } from "@/lib/frontier/api"
import { importFromGitRepo } from "@/lib/importer/git-importer"
import type { FrontierSession, FrontierGroup, GitlabProject } from "@/lib/frontier/types"
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
  const sessionKey = session.username + ":" + session.gitlabUrl
  const [filter, setFilter] = useState("")
  const [imports, setImports] = useState<Record<number, ImportState>>({})
  const [openGroups, setOpenGroups] = useState<Record<number, boolean>>({})
  const navigate = useNavigate()

  const groupsQuery = useQuery({
    queryKey: ["frontier", sessionKey, "groups"],
    queryFn: () => listGroups(session),
  })

  const groups = groupsQuery.data ?? []

  // One query per group — TanStack handles caching, dedupes refetches, and
  // each group resolves on its own timeline so the UI fills in progressively.
  const projectQueries = useQueries({
    queries: groups.map(g => ({
      queryKey: ["frontier", sessionKey, "groupProjects", g.id],
      queryFn: () => listAllGroupProjects(session, g.id),
      enabled: openGroups[g.id] === true,
    })),
  })

  const importedById = useMemo(() => {
    const m = new Map<number, ProjectRecord>()
    for (const p of localProjects) {
      if (p.origin?.kind === "git") m.set(p.origin.gitlabProjectId, p)
    }
    return m
  }, [localProjects])

  function toggleGroup(g: FrontierGroup) {
    setOpenGroups(s => ({ ...s, [g.id]: !s[g.id] }))
  }

  function expandAll() {
    setOpenGroups(Object.fromEntries(groups.map(g => [g.id, true])))
  }

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
      console.error("[import]", e)
      setImports(s => ({ ...s, [p.id]: { kind: "error", message: e instanceof Error ? e.message : String(e) } }))
    }
  }

  if (groupsQuery.isLoading) {
    return (
      <section className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading groups…
      </section>
    )
  }

  if (groupsQuery.error) {
    return (
      <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">From Frontier</h2>
        <p className="text-sm text-destructive">
          {groupsQuery.error instanceof Error ? groupsQuery.error.message : String(groupsQuery.error)}
        </p>
      </section>
    )
  }

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          From Frontier ({groups.length} group{groups.length !== 1 ? "s" : ""})
        </h2>
        <Button size="sm" variant="ghost" onClick={expandAll} className="h-7 text-xs">
          Expand all
        </Button>
        <Input
          placeholder="Filter by name or path…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="ml-auto h-8 max-w-xs"
        />
      </div>

      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No groups available.</p>
      ) : (
        <div className="space-y-1">
          {groups.map((g, i) => {
            const q = projectQueries[i]
            const isOpen = openGroups[g.id] === true
            const projects = (q.data ?? []).filter(p => {
              const f = filter.trim().toLowerCase()
              if (!f) return true
              return p.path_with_namespace.toLowerCase().includes(f) ||
                (p.description ?? "").toLowerCase().includes(f)
            })
            return (
              <div key={g.id} className="rounded border">
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
                  onClick={() => toggleGroup(g)}
                >
                  <ChevronRight className={cn("h-4 w-4 transition-transform", isOpen && "rotate-90")} />
                  <span className="text-sm font-medium">{g.path}</span>
                  {q.isFetching && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                  {q.error && <AlertCircle className="h-3 w-3 text-destructive" />}
                  {q.data && <span className="text-xs text-muted-foreground">{q.data.length}</span>}
                </button>
                {isOpen && (
                  <div className="border-t">
                    {q.error ? (
                      <p className="px-3 py-2 text-xs text-destructive">
                        {q.error instanceof Error ? q.error.message : String(q.error)}
                      </p>
                    ) : q.isLoading ? (
                      <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
                    ) : projects.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-muted-foreground">
                        {filter ? "No matches" : "No projects in this group"}
                      </p>
                    ) : (
                      <ul className="divide-y">
                        {projects.map(p => {
                          const local = importedById.get(p.id)
                          const state = imports[p.id] ?? { kind: "idle" as const }
                          return (
                            <li key={p.id} className="flex items-center gap-2 px-3 py-2">
                              <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm">{p.name}</p>
                                <p className="truncate text-xs text-muted-foreground">{p.path_with_namespace}</p>
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

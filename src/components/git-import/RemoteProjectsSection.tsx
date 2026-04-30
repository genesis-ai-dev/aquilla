import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useInfiniteQuery } from "@tanstack/react-query"
import { ChevronRight, GitBranch, Loader2, Download, Check, Folder } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { listMyProjectsPage } from "@/lib/frontier/api"
import { importFromGitRepo } from "@/lib/importer/git-importer"
import type { FrontierSession, GitlabProject } from "@/lib/frontier/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"

const PER_PAGE = 50

interface Props {
  session: FrontierSession
  localProjects: ProjectRecord[]
  onImported: (project: ProjectRecord) => void
}

interface ProjectGroup {
  name: string
  path: string
  projects: GitlabProject[]
  subgroups: Map<string, ProjectGroup>
}

function buildHierarchy(projects: GitlabProject[]): { root: ProjectGroup; total: number } {
  const root: ProjectGroup = { name: "", path: "", projects: [], subgroups: new Map() }
  for (const p of projects) {
    const parts = p.path_with_namespace.split("/")
    parts.pop() // drop project slug
    let cursor = root
    let path = ""
    for (const part of parts) {
      path = path ? `${path}/${part}` : part
      let next = cursor.subgroups.get(part)
      if (!next) {
        next = { name: part, path, projects: [], subgroups: new Map() }
        cursor.subgroups.set(part, next)
      }
      cursor = next
    }
    cursor.projects.push(p)
  }
  // Sort projects within each group + sort group keys alphabetically.
  function sort(g: ProjectGroup) {
    g.projects.sort((a, b) => a.name.localeCompare(b.name))
    const sortedKeys = [...g.subgroups.keys()].sort((a, b) => a.localeCompare(b))
    const next = new Map<string, ProjectGroup>()
    for (const k of sortedKeys) {
      const sub = g.subgroups.get(k)!
      sort(sub)
      next.set(k, sub)
    }
    g.subgroups = next
  }
  sort(root)
  return { root, total: projects.length }
}

function countAll(g: ProjectGroup): number {
  let n = g.projects.length
  for (const s of g.subgroups.values()) n += countAll(s)
  return n
}

function filterHierarchy(g: ProjectGroup, q: string): ProjectGroup | null {
  const ql = q.toLowerCase()
  const filteredProjects = g.projects.filter(p =>
    p.path_with_namespace.toLowerCase().includes(ql) ||
    (p.description ?? "").toLowerCase().includes(ql)
  )
  const filteredSubs = new Map<string, ProjectGroup>()
  for (const [k, sub] of g.subgroups) {
    const f = filterHierarchy(sub, q)
    if (f) filteredSubs.set(k, f)
  }
  if (filteredProjects.length === 0 && filteredSubs.size === 0) return null
  return { ...g, projects: filteredProjects, subgroups: filteredSubs }
}

export function RemoteProjectsSection({ session, localProjects, onImported }: Props) {
  const sessionKey = session.username + ":" + session.gitlabUrl
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const debounceRef = useRef<number | null>(null)

  useEffect(() => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => setSearch(searchInput), 300)
    return () => { if (debounceRef.current != null) window.clearTimeout(debounceRef.current) }
  }, [searchInput])

  const q = useInfiniteQuery({
    queryKey: ["frontier", sessionKey, "myProjectsAll", PER_PAGE, search],
    queryFn: ({ pageParam }) => listMyProjectsPage(session, pageParam, PER_PAGE, search),
    initialPageParam: 1,
    getNextPageParam: (lastPage, _all, lastParam) => {
      if (lastPage.nextPage != null) return lastPage.nextPage
      if (lastPage.totalPages != null) {
        return (lastParam as number) < lastPage.totalPages ? (lastParam as number) + 1 : undefined
      }
      return lastPage.items.length >= PER_PAGE ? (lastParam as number) + 1 : undefined
    },
  })

  // Pagination is explicit — see the "Load more" button below the list. The
  // previous incarnation auto-walked every page in the background, which on
  // large GitLab namespaces could fire 8+ sequential requests per Dashboard
  // mount and contend with the frontier-API calls. Users almost never browse
  // past the first page; if they do, one click is fine.

  const allProjects = useMemo(
    () => (q.data?.pages ?? []).flatMap(p => p.items),
    [q.data]
  )
  const total = q.data?.pages[0]?.total
  const loaded = allProjects.length

  const importedById = useMemo(() => {
    const m = new Map<number, ProjectRecord>()
    for (const p of localProjects) {
      if (p.origin?.kind === "git") m.set(p.origin.gitlabProjectId, p)
    }
    return m
  }, [localProjects])

  const hierarchy = useMemo(() => {
    const built = buildHierarchy(allProjects).root
    if (!search) return built
    return filterHierarchy(built, search) ?? { name: "", path: "", projects: [], subgroups: new Map() }
  }, [allProjects, search])

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          From Frontier{total != null ? ` (${loaded}${q.hasNextPage ? "+" : ""} / ${total})` : ` (${loaded})`}
        </h2>
        {q.isFetching && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
        <Input
          placeholder="Search Frontier…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          className="ml-auto h-8 max-w-xs"
        />
      </div>

      {q.error ? (
        <p className="text-sm text-destructive">
          {q.error instanceof Error ? q.error.message : String(q.error)}
        </p>
      ) : loaded === 0 && q.isLoading ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : loaded === 0 ? (
        <p className="text-sm text-muted-foreground">
          {search ? `No matches for "${search}"` : "No projects accessible."}
        </p>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto rounded border">
          {[...hierarchy.subgroups.values()].map(g => (
            <GroupNode
              key={g.path}
              group={g}
              depth={0}
              session={session}
              importedById={importedById}
              onImported={onImported}
              autoOpen={!!search}
            />
          ))}
          {hierarchy.projects.length > 0 && (
            <ul className="divide-y border-t">
              {hierarchy.projects.map(p => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  session={session}
                  local={importedById.get(p.id)}
                  onImported={onImported}
                  depth={0}
                />
              ))}
            </ul>
          )}
          {q.hasNextPage && (
            <div className="border-t bg-muted/30 px-3 py-2 flex items-center justify-center">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => q.fetchNextPage()}
                disabled={q.isFetchingNextPage}
                className="h-7"
              >
                {q.isFetchingNextPage ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    Loading more…
                  </>
                ) : (
                  <>
                    Load more
                    {total != null && (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        ({loaded} / {total})
                      </span>
                    )}
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

interface GroupNodeProps {
  group: ProjectGroup
  depth: number
  session: FrontierSession
  importedById: Map<number, ProjectRecord>
  onImported: (p: ProjectRecord) => void
  autoOpen: boolean
}

const INDENT = 16

function GroupNode({ group, depth, session, importedById, onImported, autoOpen }: GroupNodeProps) {
  const [open, setOpen] = useState(autoOpen || depth === 0)
  useEffect(() => { if (autoOpen) setOpen(true) }, [autoOpen])
  const count = countAll(group)

  return (
    <div>
      <button
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/50"
        style={{ paddingLeft: 12 + depth * INDENT }}
        onClick={() => setOpen(v => !v)}
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform shrink-0", open && "rotate-90")} />
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-sm">{group.name}</span>
        <span className="text-xs text-muted-foreground">{count}</span>
      </button>
      {open && (
        <div>
          {[...group.subgroups.values()].map(sub => (
            <GroupNode
              key={sub.path}
              group={sub}
              depth={depth + 1}
              session={session}
              importedById={importedById}
              onImported={onImported}
              autoOpen={autoOpen}
            />
          ))}
          {group.projects.length > 0 && (
            <ul className="divide-y">
              {group.projects.map(p => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  session={session}
                  local={importedById.get(p.id)}
                  onImported={onImported}
                  depth={depth + 1}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

type ImportState =
  | { kind: "idle" }
  | { kind: "running"; phase: string; done: number; total: number; label: string }
  | { kind: "done" }
  | { kind: "error"; message: string }

function ProjectRow({
  project, session, local, onImported, depth = 0,
}: {
  project: GitlabProject
  session: FrontierSession
  local: ProjectRecord | undefined
  onImported: (p: ProjectRecord) => void
  depth?: number
}) {
  const [state, setState] = useState<ImportState>({ kind: "idle" })
  const navigate = useNavigate()

  async function handleImport() {
    setState({ kind: "running", phase: "clone", done: 0, total: 1, label: project.name })
    try {
      const imported = await importFromGitRepo({
        session, project,
        onPhase: (phase, done, total, label) =>
          setState({ kind: "running", phase, done, total, label }),
      })
      setState({ kind: "done" })
      onImported(imported.project)
    } catch (e) {
      console.error("[import]", e)
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <li
      className="flex items-center gap-2 px-3 py-1.5"
      style={{ paddingLeft: 12 + depth * INDENT + 16 }}
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-sm flex-1">{project.name}</span>
      <RowAction
        local={local}
        state={state}
        onImport={handleImport}
        onOpen={() => local && navigate(`/project/${local.id}`)}
      />
    </li>
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
      <Button size="sm" variant="ghost" onClick={onOpen} className="h-7">
        <Check className="h-3.5 w-3.5 mr-1 text-green-600" /> Open
      </Button>
    )
  }
  return (
    <Button size="sm" variant="outline" onClick={onImport} className="h-7">
      <Download className="h-3.5 w-3.5 mr-1" /> Import
    </Button>
  )
}

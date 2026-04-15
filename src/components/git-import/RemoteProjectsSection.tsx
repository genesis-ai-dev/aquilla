import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, keepPreviousData } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, GitBranch, Loader2, Download, Check, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { listGroups, listGroupProjectsPage } from "@/lib/frontier/api"
import { importFromGitRepo } from "@/lib/importer/git-importer"
import type { FrontierSession, FrontierGroup, GitlabProject } from "@/lib/frontier/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { cn } from "@/lib/utils"

const PER_PAGE = 20

interface Props {
  session: FrontierSession
  localProjects: ProjectRecord[]
  onImported: (project: ProjectRecord) => void
}

export function RemoteProjectsSection({ session, localProjects, onImported }: Props) {
  const sessionKey = session.username + ":" + session.gitlabUrl
  const [filter, setFilter] = useState("")
  const [openGroups, setOpenGroups] = useState<Record<number, boolean>>({})

  const groupsQuery = useQuery({
    queryKey: ["frontier", sessionKey, "groups"],
    queryFn: () => listGroups(session),
  })
  const groups = groupsQuery.data ?? []

  const importedById = useMemo(() => {
    const m = new Map<number, ProjectRecord>()
    for (const p of localProjects) {
      if (p.origin?.kind === "git") m.set(p.origin.gitlabProjectId, p)
    }
    return m
  }, [localProjects])

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
        <Button
          size="sm" variant="ghost"
          onClick={() => setOpenGroups(Object.fromEntries(groups.map(g => [g.id, true])))}
          className="h-7 text-xs"
        >Expand all</Button>
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
          {groups.map(g => (
            <GroupSection
              key={g.id}
              group={g}
              session={session}
              sessionKey={sessionKey}
              isOpen={openGroups[g.id] === true}
              onToggle={() => setOpenGroups(s => ({ ...s, [g.id]: !s[g.id] }))}
              filter={filter}
              importedById={importedById}
              onImported={onImported}
            />
          ))}
        </div>
      )}
    </section>
  )
}

interface GroupSectionProps {
  group: FrontierGroup
  session: FrontierSession
  sessionKey: string
  isOpen: boolean
  onToggle: () => void
  filter: string
  importedById: Map<number, ProjectRecord>
  onImported: (p: ProjectRecord) => void
}

function GroupSection({
  group, session, sessionKey, isOpen, onToggle, filter, importedById, onImported,
}: GroupSectionProps) {
  const [page, setPage] = useState(1)

  const q = useQuery({
    queryKey: ["frontier", sessionKey, "groupProjects", group.id, page, PER_PAGE],
    queryFn: () => listGroupProjectsPage(session, group.id, page, PER_PAGE),
    enabled: isOpen,
    placeholderData: keepPreviousData,
  })

  const items = q.data?.items ?? []
  const total = q.data?.total
  const totalPages = q.data?.totalPages
  // If the server doesn't expose totals, infer "has next" from page length.
  const hasNext = q.data
    ? (q.data.nextPage != null
        ? true
        : totalPages != null
          ? page < totalPages
          : items.length === PER_PAGE)
    : false
  const hasPrev = page > 1

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase()
    if (!f) return items
    return items.filter(p =>
      p.path_with_namespace.toLowerCase().includes(f) ||
      (p.description ?? "").toLowerCase().includes(f)
    )
  }, [items, filter])

  return (
    <div className="rounded border">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
        onClick={onToggle}
      >
        <ChevronRight className={cn("h-4 w-4 transition-transform", isOpen && "rotate-90")} />
        <span className="text-sm font-medium">{group.path}</span>
        {q.isFetching && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        {q.error && <AlertCircle className="h-3 w-3 text-destructive" />}
        {total != null && (
          <span className="text-xs text-muted-foreground">{total}</span>
        )}
      </button>
      {isOpen && (
        <div className="border-t">
          {q.error ? (
            <p className="px-3 py-2 text-xs text-destructive">
              {q.error instanceof Error ? q.error.message : String(q.error)}
            </p>
          ) : q.isLoading ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
          ) : (
            <>
              {filtered.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  {filter ? "No matches on this page" : "No projects in this group"}
                </p>
              ) : (
                <ul className="divide-y">
                  {filtered.map(p => (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      session={session}
                      local={importedById.get(p.id)}
                      onImported={onImported}
                    />
                  ))}
                </ul>
              )}
              {(hasPrev || hasNext) && (
                <div className="flex items-center justify-between border-t px-2 py-1.5">
                  <Button
                    size="sm" variant="ghost"
                    disabled={!hasPrev || q.isFetching}
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    className="h-7 text-xs"
                  >
                    <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Prev
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Page {page}{totalPages != null ? ` of ${totalPages}` : ""}
                  </span>
                  <Button
                    size="sm" variant="ghost"
                    disabled={!hasNext || q.isFetching}
                    onClick={() => setPage(p => p + 1)}
                    className="h-7 text-xs"
                  >
                    Next <ChevronRight className="h-3.5 w-3.5 ml-1" />
                  </Button>
                </div>
              )}
            </>
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
  project, session, local, onImported,
}: {
  project: GitlabProject
  session: FrontierSession
  local: ProjectRecord | undefined
  onImported: (p: ProjectRecord) => void
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
    <li className="flex items-center gap-2 px-3 py-2">
      <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{project.name}</p>
        <p className="truncate text-xs text-muted-foreground">{project.path_with_namespace}</p>
      </div>
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

import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, keepPreviousData } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight, GitBranch, Loader2, Download, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { listMyProjectsPage } from "@/lib/frontier/api"
import { importFromGitRepo } from "@/lib/importer/git-importer"
import type { FrontierSession, GitlabProject } from "@/lib/frontier/types"
import type { ProjectRecord } from "@/lib/parsers/types"

const PER_PAGE = 20

interface Props {
  session: FrontierSession
  localProjects: ProjectRecord[]
  onImported: (project: ProjectRecord) => void
}

export function RemoteProjectsSection({ session, localProjects, onImported }: Props) {
  const sessionKey = session.username + ":" + session.gitlabUrl
  const [page, setPage] = useState(1)
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const debounceRef = useRef<number | null>(null)

  // Debounce search input -> server-side search, reset to page 1
  useEffect(() => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      setSearch(prev => {
        if (prev === searchInput) return prev
        setPage(1)
        return searchInput
      })
    }, 300)
    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    }
  }, [searchInput])

  const q = useQuery({
    queryKey: ["frontier", sessionKey, "myProjects", page, PER_PAGE, search],
    queryFn: () => listMyProjectsPage(session, page, PER_PAGE, search),
    placeholderData: keepPreviousData,
  })

  const items = q.data?.items ?? []
  const total = q.data?.total
  const totalPages = q.data?.totalPages
  const hasNext = q.data
    ? (q.data.nextPage != null ? true
      : totalPages != null ? page < totalPages
      : items.length >= PER_PAGE)
    : false
  const hasPrev = page > 1

  const importedById = useMemo(() => {
    const m = new Map<number, ProjectRecord>()
    for (const p of localProjects) {
      if (p.origin?.kind === "git") m.set(p.origin.gitlabProjectId, p)
    }
    return m
  }, [localProjects])

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          From Frontier{total != null ? ` (${total})` : ""}
        </h2>
        {q.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
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
      ) : q.isLoading ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {search ? `No matches for "${search}"` : "No projects accessible."}
        </p>
      ) : (
        <div className="rounded border">
          <ul className="divide-y">
            {items.map(p => (
              <ProjectRow
                key={p.id}
                project={p}
                session={session}
                local={importedById.get(p.id)}
                onImported={onImported}
              />
            ))}
          </ul>
          <div className="flex items-center justify-between border-t px-2 py-1.5">
            <Button
              size="sm" variant="ghost"
              disabled={!hasPrev || q.isFetching}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="h-7 text-xs"
            >
              <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Prev
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums">
              Page {page}{totalPages != null ? ` of ${totalPages}` : ""}
              {" · "}{items.length} shown
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
        </div>
      )}
    </section>
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

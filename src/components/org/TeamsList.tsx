import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { listTeams, createTeam, type TeamSummary } from "@/lib/frontier/teams"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type SortOption = "name" | "members" | "projects"

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "name", label: "Name (A–Z)" },
  { value: "members", label: "Members (most first)" },
  { value: "projects", label: "Projects (most first)" },
]

function sortTeams(teams: TeamSummary[], sort: SortOption): TeamSummary[] {
  return [...teams].sort((a, b) => {
    if (sort === "members") return b.memberCount - a.memberCount
    if (sort === "projects") return b.projectCount - a.projectCount
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  })
}

export function TeamsList() {
  const { activeOrgId, activeOrg } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<SortOption>("name")

  const isAdmin = (activeOrg?.role.level ?? 0) >= 600

  useEffect(() => {
    if (!jwt || activeOrgId == null) return
    let cancelled = false
    setLoading(true)
    listTeams(jwt, activeOrgId)
      .then((list) => { if (!cancelled) setTeams(list) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jwt, activeOrgId])

  const filtered = sortTeams(
    query.trim()
      ? teams.filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase()))
      : teams,
    sort,
  )

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Teams" />}
      statusBar={null}
      main={
        <div className="h-full overflow-y-auto p-6">
          {isAdmin && (
            <div className="mb-4">
              {!creating ? (
                <button onClick={() => setCreating(true)} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">New team</button>
              ) : (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault()
                    if (!jwt || activeOrgId == null || !name.trim()) return
                    const t = await createTeam(jwt, activeOrgId, name.trim(), description.trim() || undefined)
                    navigate(`/teams/${t.id}`)
                  }}
                  className="flex flex-wrap items-center gap-2"
                >
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" className="rounded-md border px-2 py-1 text-sm" />
                  <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" className="rounded-md border px-2 py-1 text-sm" />
                  <button type="submit" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">Create</button>
                  <button type="button" onClick={() => setCreating(false)} className="text-sm text-muted-foreground">Cancel</button>
                </form>
              )}
            </div>
          )}

          {/* Search + sort bar */}
          {!loading && teams.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search teams…"
                className="min-w-0 flex-1 rounded-md border px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <Select
                items={SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                value={sort}
                onValueChange={(v) => setSort((v ?? "name") as SortOption)}
              >
                <SelectTrigger aria-label="Sort teams by">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {SORT_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          )}

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : teams.length === 0 ? (
            <p className="text-sm text-muted-foreground">No teams in this org yet.</p>
          ) : filtered.length === 0 ? (
            <div className="flex items-center gap-3">
              <p className="text-sm text-muted-foreground">No teams match &ldquo;{query}&rdquo;</p>
              <button
                onClick={() => setQuery("")}
                className="text-sm text-primary underline-offset-2 hover:underline"
              >
                Clear
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((t) => (
                <button
                  key={t.id}
                  onClick={() => navigate(`/teams/${t.id}`)}
                  className="rounded-lg border p-4 text-left hover:bg-accent/40"
                >
                  <span className="block font-medium">{t.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t.memberCount} members · {t.projectCount} projects
                  </span>
                  {t.viewerIsMember && (
                    <span className="mt-1 block text-xs text-muted-foreground/70">Member</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      }
    />
  )
}

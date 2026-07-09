import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Plus, Search, Users } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Page, PageHeader, EmptyState } from "@/components/ui/page"
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

// AQU-333: three-position internal/public filter. Default is "internal",
// which preserves the org's historical "shows internal groups only" default
// render. The FRO-158 guarantee (public teams are never silently dropped)
// still holds — they remain reachable via "all"/"public".
type Visibility = "all" | "internal" | "public"

const VISIBILITY_OPTIONS: { value: Visibility; label: string }[] = [
  { value: "all", label: "All" },
  { value: "internal", label: "Internal only" },
  { value: "public", label: "Public only" },
]

function filterByVisibility(teams: TeamSummary[], visibility: Visibility): TeamSummary[] {
  if (visibility === "internal") return teams.filter((t) => t.isInternal)
  if (visibility === "public") return teams.filter((t) => !t.isInternal)
  return teams
}

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
  const [visibility, setVisibility] = useState<Visibility>("internal")

  const isAdmin = (activeOrg?.role.level ?? 0) >= 600

  useEffect(() => {
    if (!jwt || activeOrgId == null) {
      setTeams([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    listTeams(jwt, activeOrgId)
      .then((list) => { if (!cancelled) setTeams(list) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jwt, activeOrgId])

  const byVisibility = filterByVisibility(teams, visibility)
  const filtered = sortTeams(
    query.trim()
      ? byVisibility.filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase()))
      : byVisibility,
    sort,
  )

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Teams" />}
      statusBar={null}
      main={
        <Page size="wide">
          <PageHeader
            title="Teams"
            description="Group members and grant project access together."
            actions={
              isAdmin ? (
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus className="size-4" />
                  New team
                </Button>
              ) : null
            }
          />

          {isAdmin && (
            <Dialog
              open={creating}
              onOpenChange={(o) => { if (!o) { setCreating(false); setName(""); setDescription("") } }}
            >
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>New team</DialogTitle>
                </DialogHeader>
                <form
                  id="create-team-form"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    if (!jwt || activeOrgId == null || !name.trim()) return
                    const t = await createTeam(jwt, activeOrgId, name.trim(), description.trim() || undefined)
                    navigate(`/teams/${t.id}`)
                  }}
                  className="space-y-2"
                >
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Team name"
                    autoFocus
                  />
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Description (optional)"
                  />
                </form>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => { setCreating(false); setName(""); setDescription("") }}>
                    Cancel
                  </Button>
                  <Button type="submit" form="create-team-form" disabled={!name.trim()}>Create</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}

          {/* Search + sort bar */}
          {!loading && teams.length > 0 && (
            <div className="mb-6 flex flex-wrap items-center gap-2">
              <InputGroup className="min-w-0 flex-1">
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search teams…"
                />
              </InputGroup>
              <Select
                items={SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                value={sort}
                onValueChange={(v) => setSort((v ?? "name") as SortOption)}
              >
                <SelectTrigger aria-label="Sort teams by" className="w-56">
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
              <ButtonGroup aria-label="Filter teams by visibility">
                {VISIBILITY_OPTIONS.map((o) => (
                  <Button
                    key={o.value}
                    size="sm"
                    variant={visibility === o.value ? "default" : "outline"}
                    aria-pressed={visibility === o.value}
                    onClick={() => setVisibility(o.value)}
                  >
                    {o.label}
                  </Button>
                ))}
              </ButtonGroup>
            </div>
          )}

          {activeOrgId == null ? (
            <EmptyState
              icon={Users}
              title="Select an organization"
              description="Teams are managed within a single organization. Choose one from the switcher to continue."
            />
          ) : loading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="h-20 animate-pulse rounded-2xl border bg-card" />
              <div className="h-20 animate-pulse rounded-2xl border bg-card" />
              <div className="h-20 animate-pulse rounded-2xl border bg-card" />
            </div>
          ) : teams.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No teams in this org yet."
              description={
                isAdmin
                  ? "Create a team to group members and grant project access together."
                  : "An org admin can create teams to group members and grant project access together."
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Search}
              title={
                query.trim()
                  ? <>No teams match &ldquo;{query}&rdquo;</>
                  : visibility === "public"
                    ? "No public teams in this organization"
                    : visibility === "internal"
                      ? "No internal teams in this organization"
                      : "No teams match your filters"
              }
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setQuery(""); setVisibility("all") }}
                >
                  Clear
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((t) => (
                <button
                  key={t.id}
                  onClick={() => navigate(`/teams/${t.id}`)}
                  className="rounded-2xl border bg-card p-4 text-left transition-colors hover:bg-accent/40"
                >
                  <span className="block truncate font-medium text-foreground">{t.name}</span>
                  <span className="mt-1 block text-sm tabular-nums text-muted-foreground">
                    {t.memberCount} members · {t.projectCount} projects
                  </span>
                  <span className="mt-2 flex flex-wrap gap-1">
                    {!t.isInternal && (
                      <span className="inline-block rounded-full border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
                        Public
                      </span>
                    )}
                    {t.viewerIsMember && (
                      <span className="inline-block rounded-full border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
                        Member
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Page>
      }
    />
  )
}

import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Plus, Search, Users } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { Button } from "@/components/ui/button"
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
              title={<>No teams match &ldquo;{query}&rdquo;</>}
              action={
                <Button size="sm" variant="outline" onClick={() => setQuery("")}>
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
                  {t.viewerIsMember && (
                    <span className="mt-2 inline-block rounded-full border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
                      Member
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </Page>
      }
    />
  )
}

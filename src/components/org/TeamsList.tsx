import { useEffect, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { useNavigate } from "react-router-dom"
import { Plus, Search, Users } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { SegmentTabs } from "@/components/ui/tabs"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { optionalString, requiredString } from "@/lib/forms/schemas"
import { useSubmitError } from "@/lib/forms/submit-error"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Page, PageHeader, EmptyState } from "@/components/ui/page"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { listTeams, createTeam, type TeamSummary } from "@/lib/frontier/teams"
import { orgPath } from "@/lib/navigation/org-paths"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type SortOption = "name" | "members" | "projects"

const createTeamSchema = z.object({
  name: requiredString("Team name"),
  description: optionalString,
})

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
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<SortOption>("name")
  const [visibility, setVisibility] = useState<Visibility>("internal")
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const createTeamForm = useForm({
    defaultValues: { name: "", description: "" },
    validators: { onSubmit: createTeamSchema },
    onSubmit: async ({ value }) => {
      if (!jwt || activeOrgId == null) return
      clearSubmitError()
      try {
        const t = await createTeam(
          jwt,
          activeOrgId,
          value.name.trim(),
          value.description.trim() || undefined,
        )
        setCreating(false)
        createTeamForm.reset()
        navigate(orgPath(activeOrgId, `/teams/${t.id}`))
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : "Couldn't create team.")
      }
    },
  })

  const isAdmin = (activeOrg?.role.level ?? 0) >= 600

  useEffect(() => {
    if (!creating) return
    createTeamForm.reset()
    clearSubmitError()
  }, [creating, createTeamForm, clearSubmitError])

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
              onOpenChange={(o) => { if (!o) setCreating(false) }}
            >
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>New team</DialogTitle>
                </DialogHeader>
                <form
                  id="create-team-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void createTeamForm.handleSubmit()
                  }}
                >
                  <FieldGroup>
                    <createTeamForm.Field
                      name="name"
                      children={(field) => {
                        const invalid = isFieldInvalid(field)
                        return (
                          <Field data-invalid={invalid}>
                            <FieldLabel htmlFor="create-team-name">Team name</FieldLabel>
                            <Input
                              id="create-team-name"
                              name={field.name}
                              value={field.state.value}
                              onBlur={field.handleBlur}
                              onChange={(e) => field.handleChange(e.target.value)}
                              placeholder="Team name"
                              aria-invalid={invalid}
                              autoFocus
                            />
                            {invalid && <FieldError errors={field.state.meta.errors} />}
                          </Field>
                        )
                      }}
                    />
                    <createTeamForm.Field
                      name="description"
                      children={(field) => (
                        <Field>
                          <FieldLabel htmlFor="create-team-desc">Description (optional)</FieldLabel>
                          <Input
                            id="create-team-desc"
                            name={field.name}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                            placeholder="Description (optional)"
                          />
                        </Field>
                      )}
                    />
                  </FieldGroup>
                  {submitError && (
                    <FieldError role="alert" className="mt-3">
                      {submitError}
                    </FieldError>
                  )}
                </form>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" form="create-team-form">
                    {createTeamForm.state.isSubmitting && <Spinner data-icon="inline-start" />}
                    {createTeamForm.state.isSubmitting ? "Creating…" : "Create"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}

          {/* Search + sort bar */}
          {!loading && teams.length > 0 && (
            <div className="mb-6 flex flex-wrap items-center gap-2">
              <InputGroup className="min-w-0 flex-1 bg-card">
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
              <SegmentTabs
                aria-label="Filter teams by visibility"
                value={visibility}
                onValueChange={setVisibility}
                options={VISIBILITY_OPTIONS}
              />
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
                  onClick={() => activeOrgId != null && navigate(orgPath(activeOrgId, `/teams/${t.id}`))}
                  className="rounded-2xl border bg-card p-4 text-left transition-colors hover:bg-accent/40"
                >
                  <span className="block truncate font-medium text-foreground">{t.name}</span>
                  <span className="mt-1 block text-sm tabular-nums text-muted-foreground">
                    {t.memberCount} members · {t.projectCount} projects
                  </span>
                  <span className="mt-2 flex flex-wrap gap-1">
                    {!t.isInternal && (
                      <Badge variant="secondary">
                        Public
                      </Badge>
                    )}
                    {t.viewerIsMember && (
                      <Badge variant="secondary">
                        Member
                      </Badge>
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

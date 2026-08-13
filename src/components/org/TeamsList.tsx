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
import { ButtonGroup } from "@/components/ui/button-group"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
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
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
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

const SORT_OPTIONS: { value: SortOption; labelKey: MessageKey }[] = [
  { value: "name", labelKey: "org.teamsList.sortNameLabel" },
  { value: "members", labelKey: "org.teamsList.sortMembersLabel" },
  { value: "projects", labelKey: "org.teamsList.sortProjectsLabel" },
]

// AQU-333: three-position internal/public filter. Default is "internal",
// which preserves the org's historical "shows internal groups only" default
// render. The FRO-158 guarantee (public teams are never silently dropped)
// still holds — they remain reachable via "all"/"public".
type Visibility = "all" | "internal" | "public"

const VISIBILITY_OPTIONS: { value: Visibility; labelKey: MessageKey }[] = [
  { value: "all", labelKey: "org.orgHome.statusFilter.all" },
  { value: "internal", labelKey: "org.teamsList.visibilityInternalLabel" },
  { value: "public", labelKey: "org.teamsList.visibilityPublicLabel" },
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
  const t = useT()
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
        setSubmitError(err instanceof Error ? err.message : t("org.teamsList.createErrorFallback"))
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
      header={<OrgBreadcrumb section={t("editor.navTitle.teams")} />}
      statusBar={null}
      main={
        <Page size="wide">
          <PageHeader
            title={t("editor.navTitle.teams")}
            description={t("org.teamsList.pageDescription")}
            actions={
              isAdmin ? (
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus className="size-4" />
                  {t("org.teamsList.newTeamButton")}
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
                  <DialogTitle>{t("org.teamsList.newTeamButton")}</DialogTitle>
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
                            <FieldLabel htmlFor="create-team-name">{t("org.teamForm.nameLabel")}</FieldLabel>
                            <Input
                              id="create-team-name"
                              name={field.name}
                              value={field.state.value}
                              onBlur={field.handleBlur}
                              onChange={(e) => field.handleChange(e.target.value)}
                              placeholder={t("org.teamForm.nameLabel")}
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
                          <FieldLabel htmlFor="create-team-desc">{t("common.descriptionOptional")}</FieldLabel>
                          <Input
                            id="create-team-desc"
                            name={field.name}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                            placeholder={t("common.descriptionOptional")}
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
                    {t("common.cancel")}
                  </Button>
                  <Button type="submit" form="create-team-form">
                    {createTeamForm.state.isSubmitting && <Spinner data-icon="inline-start" />}
                    {createTeamForm.state.isSubmitting ? t("common.creating") : t("org.switcher.create")}
                  </Button>
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
                  placeholder={t("org.teamsList.searchPlaceholder")}
                />
              </InputGroup>
              <Select
                items={SORT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                value={sort}
                onValueChange={(v) => setSort((v ?? "name") as SortOption)}
              >
                <SelectTrigger aria-label={t("org.teamsList.sortByAriaLabel")} className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {SORT_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{t(o.labelKey)}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <ButtonGroup aria-label={t("org.teamsList.visibilityFilterAriaLabel")}>
                {VISIBILITY_OPTIONS.map((o) => (
                  <Button
                    key={o.value}
                    size="sm"
                    variant={visibility === o.value ? "default" : "outline"}
                    aria-pressed={visibility === o.value}
                    onClick={() => setVisibility(o.value)}
                  >
                    {t(o.labelKey)}
                  </Button>
                ))}
              </ButtonGroup>
            </div>
          )}

          {activeOrgId == null ? (
            <EmptyState
              icon={Users}
              title={t("org.teamsList.selectOrgTitle")}
              description={t("org.teamsList.selectOrgDescription")}
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
              title={t("org.teamsList.noTeamsTitle")}
              description={
                isAdmin
                  ? t("org.teamsList.noTeamsAdminDescription")
                  : t("org.teamsList.noTeamsNonAdminDescription")
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Search}
              title={
                query.trim()
                  ? t("org.teamsList.noTeamsMatchQuery", { query })
                  : visibility === "public"
                    ? t("org.teamsList.noPublicTeams")
                    : visibility === "internal"
                      ? t("org.teamsList.noInternalTeams")
                      : t("org.teamsList.noTeamsMatchFilters")
              }
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setQuery(""); setVisibility("all") }}
                >
                  {t("common.clear")}
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((team) => (
                <button
                  key={team.id}
                  onClick={() => activeOrgId != null && navigate(orgPath(activeOrgId, `/teams/${team.id}`))}
                  className="rounded-2xl border bg-card p-4 text-start transition-colors hover:bg-accent/40"
                >
                  <span className="block truncate font-medium text-foreground">{team.name}</span>
                  <span className="mt-1 block text-sm tabular-nums text-muted-foreground">
                    {t("org.teamsList.memberCount", { count: team.memberCount })} · {t("org.orgHome.organizationsPanel.projectCount", { count: team.projectCount })}
                  </span>
                  <span className="mt-2 flex flex-wrap gap-1">
                    {!team.isInternal && (
                      <Badge variant="secondary">
                        {t("org.teamsList.publicBadge")}
                      </Badge>
                    )}
                    {team.viewerIsMember && (
                      <Badge variant="secondary">
                        {t("org.teamsList.memberBadge")}
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

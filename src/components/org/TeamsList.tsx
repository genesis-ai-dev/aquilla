import { useEffect, useMemo, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { type ColumnDef } from "@tanstack/react-table"
import { z } from "zod"
import { useNavigate } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field, FieldError, FieldGroup, FieldLabel, OptionalMark } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { optionalString, requiredString } from "@/lib/forms/schemas"
import { useSubmitError } from "@/lib/forms/submit-error"
import { Page, PageHeader, EmptyState } from "@/components/ui/page"
import { TeamWithAvatar } from "@/components/TeamWithAvatar"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { listTeams, createTeam, type TeamSummary } from "@/lib/frontier/teams"
import { orgPath } from "@/lib/navigation/org-paths"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"

const createTeamSchema = z.object({
  name: requiredString("Team name"),
  description: optionalString,
})

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

function VisibilitySelect({
  value,
  onValueChange,
}: {
  value: Visibility
  onValueChange: (value: Visibility) => void
}) {
  return (
    <Select
      items={VISIBILITY_OPTIONS}
      value={value}
      onValueChange={(v) => onValueChange((v as Visibility) ?? "internal")}
    >
      <SelectTrigger aria-label="Filter teams by visibility" className="w-[11rem] bg-card">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectGroup>
          {VISIBILITY_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

export function TeamsList() {
  const { activeOrgId, activeOrg } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
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

  const visibleTeams = useMemo(
    () => filterByVisibility(teams, visibility),
    [teams, visibility],
  )


  const columns = useMemo<ColumnDef<TeamSummary>[]>(
    () => [
      {
        id: "name",
        accessorFn: (t) => t.name.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Team" />,
        meta: { className: "min-w-0" },
        cell: ({ row }) => {
          const t = row.original
          return (
            <div className="flex min-w-0 items-center gap-2">
              <TeamWithAvatar name={t.name} size="xs" nameClassName="font-normal" className="min-w-0" />
              <span className="flex shrink-0 flex-wrap gap-1">
                {!t.isInternal && <Badge variant="secondary">Public</Badge>}
                {t.viewerIsMember && <Badge variant="secondary">Member</Badge>}
              </span>
            </div>
          )
        },
      },
      {
        accessorKey: "memberCount",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Members" className="justify-end" />
        ),
        meta: { className: "w-[6.5rem]" },
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-muted-foreground">
            {row.original.memberCount}
          </div>
        ),
      },
      {
        accessorKey: "projectCount",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Projects" className="justify-end" />
        ),
        meta: { className: "w-[6.5rem]" },
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-muted-foreground">
            {row.original.projectCount}
          </div>
        ),
      },
    ],
    [],
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
            inset={false}
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
                  autoComplete="off"
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
                              // Avoid DOM name="name" — Chrome contact autofill heuristic.
                              name="aquilla-team-name"
                              autoComplete="off"
                              autoCorrect="off"
                              autoCapitalize="none"
                              spellCheck={false}
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
                          <FieldLabel htmlFor="create-team-desc">
                            Description <OptionalMark />
                          </FieldLabel>
                          <Textarea
                            id="create-team-desc"
                            name="aquilla-team-description"
                            autoComplete="off"
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                            placeholder="Description"
                            rows={3}
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

          {activeOrgId == null ? (
            <EmptyState
              icon={NAV_PAGE_ICONS.teams}
              title="Select an organization"
              description="Teams are managed within a single organization. Choose one from the switcher to continue."
            />
          ) : loading ? (
            <div className="h-48 animate-pulse rounded-lg border bg-card" />
          ) : (
            <DataTable
              columns={columns}
              data={visibleTeams}
              getRowId={(t) => String(t.id)}
              onRowClick={(t) => {
                if (activeOrgId != null) navigate(orgPath(activeOrgId, `/teams/${t.id}`))
              }}
              initialSorting={[{ id: "name", desc: false }]}
              searchPlaceholder="Search teams…"
              globalFilterFn={(row, _columnId, filterValue) => {
                const q = String(filterValue).trim().toLowerCase()
                if (!q) return true
                return row.original.name.toLowerCase().includes(q)
              }}
              toolbar={
                <>
                  <VisibilitySelect value={visibility} onValueChange={setVisibility} />
                  {isAdmin ? (
                    <Button
                      className="ml-auto shrink-0"
                      onClick={() => setCreating(true)}
                    >
                      New team
                    </Button>
                  ) : null}
                </>
              }
              emptyState={(table) => {
                const search = String(table.getState().globalFilter ?? "").trim()
                if (teams.length === 0) {
                  return (
                    <EmptyState
                      icon={NAV_PAGE_ICONS.teams}
                      title="No teams in this org yet."
                      description={
                        isAdmin
                          ? "Create a team to group members and grant project access together."
                          : "An org admin can create teams to group members and grant project access together."
                      }
                    />
                  )
                }
                if (visibleTeams.length === 0 && !search) {
                  return (
                    <EmptyState
                      icon={NAV_PAGE_ICONS.teams}
                      title={
                        visibility === "public"
                          ? "No public teams in this organization"
                          : visibility === "internal"
                            ? "No internal teams in this organization"
                            : "No teams match your filters"
                      }
                      action={
                        <Button
                          variant="outline"
                          onClick={() => setVisibility("all")}
                        >
                          Clear
                        </Button>
                      }
                    />
                  )
                }
                return (
                  <div className="flex flex-col items-center gap-3 py-10">
                    <p className="text-center text-sm text-muted-foreground">
                      No teams match your search.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => table.setGlobalFilter("")}
                    >
                      Clear
                    </Button>
                  </div>
                )
              }}
              testId="org-teams-table"
              className={ADMIN_TABLE_PANEL_CLASS}
              dense
            />
          )}
        </Page>
      }
    />
  )
}

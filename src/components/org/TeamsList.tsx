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
import { Page, PageHeader, EmptyState, TableEmptyState } from "@/components/ui/page"
import { TeamWithAvatar } from "@/components/TeamWithAvatar"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useTeamDirectory } from "@/hooks/useTeamDirectory"
import { createTeam, type TeamDirectoryVisibility, type TeamSummary } from "@/lib/frontier/teams"
import { orgPath } from "@/lib/navigation/org-paths"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

const createTeamSchema = z.object({
  name: requiredString("Team name"),
  description: optionalString,
})

// AQU-333: three-position internal/public filter. Default is "internal",
// which preserves the org's historical "shows internal groups only" default
// render. The FRO-158 guarantee (public teams are never silently dropped)
// still holds — they remain reachable via "all"/"public".
type Visibility = TeamDirectoryVisibility

/**
 * Catalog keys, not display strings — resolved with `t()` at render time in
 * `VisibilitySelect` below. `internal`/`public` reuse this component's own
 * previously-unwired org.teamsList.visibility*Label keys; `all` reuses the
 * identical-text key from OrgHome's status filter.
 */
const VISIBILITY_OPTIONS: { value: Visibility; labelKey: MessageKey }[] = [
  { value: "all", labelKey: "org.orgHome.statusFilter.all" },
  { value: "internal", labelKey: "org.teamsList.visibilityInternalLabel" },
  { value: "public", labelKey: "org.teamsList.visibilityPublicLabel" },
]

function VisibilitySelect({
  value,
  onValueChange,
}: {
  value: Visibility
  onValueChange: (value: Visibility) => void
}) {
  const { t } = useI18n()
  const items = VISIBILITY_OPTIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(v) => onValueChange((v as Visibility) ?? "internal")}
    >
      <SelectTrigger aria-label={t("org.teamsList.visibilityFilterAriaLabel")} className="w-[11rem] bg-card">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectGroup>
          {items.map((opt) => (
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
  const { t } = useI18n()
  const { activeOrgId, activeOrg } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [visibility, setVisibility] = useState<Visibility>("internal")
  const [teamQuery, setTeamQuery] = useState("")
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
  const directory = useTeamDirectory({
    jwt,
    enabled: Boolean(jwt) && activeOrgId != null,
    orgId: activeOrgId,
    query: teamQuery,
    visibility,
  })

  useEffect(() => {
    if (!creating) return
    createTeamForm.reset()
    clearSubmitError()
  }, [creating, createTeamForm, clearSubmitError])

  const teams = directory.teams
  const loading = directory.loading && directory.teams.length === 0

  const columns = useMemo<ColumnDef<TeamSummary>[]>(
    () => [
      {
        id: "name",
        accessorFn: (t) => t.name.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("editor.navTitle.team")} />,
        meta: { className: "min-w-0" },
        cell: ({ row }) => {
          const row_ = row.original
          return (
            <div className="flex min-w-0 items-center gap-2">
              <TeamWithAvatar name={row_.name} size="xs" nameClassName="font-normal" className="min-w-0" />
              <span className="flex shrink-0 flex-wrap gap-1">
                {!row_.isInternal && <Badge variant="secondary">{t("org.teamsList.publicBadge")}</Badge>}
                {row_.viewerIsMember && <Badge variant="secondary">{t("org.teamsList.memberBadge")}</Badge>}
              </span>
            </div>
          )
        },
      },
      {
        accessorKey: "memberCount",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("editor.navTitle.members")} className="justify-end" />
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
          <DataTableColumnHeader column={column} title={t("nav.projects")} className="justify-end" />
        ),
        meta: { className: "w-[6.5rem]" },
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-muted-foreground">
            {row.original.projectCount}
          </div>
        ),
      },
    ],
    [t],
  )

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section="Teams" />}
      statusBar={null}
      main={
        <Page size="wide" fill>
          <PageHeader
            className="shrink-0"
            title={t("editor.navTitle.teams")}
            description={t("org.teamsList.pageDescription")}
            inset={false}
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
                            <FieldLabel htmlFor="create-team-name">{t("org.teamForm.nameLabel")}</FieldLabel>
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
                          <FieldLabel htmlFor="create-team-desc">
                            {t("nav.report.descriptionFieldLabel")} <OptionalMark />
                          </FieldLabel>
                          <Textarea
                            id="create-team-desc"
                            name="aquilla-team-description"
                            autoComplete="off"
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                            placeholder={t("nav.report.descriptionFieldLabel")}
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
                    {t("common.cancel")}
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
              title={t("org.teamsList.selectOrgTitle")}
              description={t("org.teamsList.selectOrgDescription")}
            />
          ) : (
            <>
              {directory.error ? (
                <p className="shrink-0 text-sm text-destructive">{directory.error}</p>
              ) : null}
              <DataTable
              columns={columns}
              data={teams}
              loading={loading}
              getRowId={(t) => String(t.id)}
              onRowClick={(t) => {
                if (activeOrgId != null) navigate(orgPath(activeOrgId, `/teams/${t.id}`))
              }}
              initialSorting={[{ id: "name", desc: false }]}
              searchPlaceholder="Search teams…"
              searchValue={teamQuery}
              onSearchChange={setTeamQuery}
              searching={directory.searching}
              hasMore={directory.hasMore}
              onLoadMore={directory.loadMore}
              loadingMore={directory.loadingMore}
              loadMoreTestId="team-directory-load-more"
              toolbar={
                <>
                  <VisibilitySelect value={visibility} onValueChange={setVisibility} />
                  {isAdmin ? (
                    <Button
                      className="ml-auto shrink-0"
                      onClick={() => setCreating(true)}
                    >
                      {t("org.teamsList.newTeamButton")}
                    </Button>
                  ) : null}
                </>
              }
              emptyState={() => {
                const search = teamQuery.trim()
                if (teams.length === 0 && !search && visibility !== "all") {
                  return (
                    <TableEmptyState
                      icon={NAV_PAGE_ICONS.teams}
                      title={
                        visibility === "public"
                          ? "No public teams in this organization"
                          : "No internal teams in this organization"
                      }
                      action={
                        <Button
                          variant="outline"
                          onClick={() => setVisibility("all")}
                        >
                          {t("common.clear")}
                        </Button>
                      }
                    />
                  )
                }
                if (teams.length === 0 && !search) {
                  return (
                    <TableEmptyState
                      icon={NAV_PAGE_ICONS.teams}
                      title={t("org.teamsList.noTeamsTitle")}
                      description={
                        isAdmin
                          ? "Create a team to group members and grant project access together."
                          : "An org admin can create teams to group members and grant project access together."
                      }
                    />
                  )
                }
                return (
                  <div className="flex flex-col items-center gap-3 py-10">
                    <p className="text-center text-sm text-muted-foreground">
                      {t("org.teamsList.noTeamsMatchSearch")}
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => setTeamQuery("")}
                    >
                      {t("common.clear")}
                    </Button>
                  </div>
                )
              }}
              testId="org-teams-table"
              className={ADMIN_TABLE_PANEL_CLASS}
              dense
              fillHeight
            />
            </>
          )}
        </Page>
      }
    />
  )
}

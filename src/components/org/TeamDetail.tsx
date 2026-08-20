import { useCallback, useEffect, useMemo, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { Link, useNavigate, useParams } from "react-router-dom"
import { FolderGit2, Settings, ShieldUser, Unlink, UserMinus, Users } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { MemberMultiSelect } from "@/components/MemberMultiSelect"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DataTable,
  DataTableColumnHeader,
  DataTableRowActionsButton,
} from "@/components/ui/data-table"
import { missingLast, SORT_MISSING_LAST } from "@/components/ui/data-table-missing"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { MenuItem, MenuSeparator } from "@/components/ui/menu-parts"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { Page, EmptyState, NotFoundIcon, TableEmptyState } from "@/components/ui/page"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DisabledFieldTooltip } from "@/components/ProjectSettings/DisabledFieldTooltip"
import { AppTooltip } from "@/components/ui/tooltip"
import { useActiveOrg } from "@/context/OrgContext"
import { useNavHistoryTitle } from "@/context/NavHistoryContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { orgPath, teamSettingsPath } from "@/lib/navigation/org-paths"
import { cn } from "@/lib/utils"
import {
  getTeam,
  addTeamMembers,
  removeTeamMember,
  attachProject,
  changeProjectRole,
  detachProject,
  type TeamDetail as TeamDetailType,
} from "@/lib/frontier/teams"
import { listOrgMembers, addOrgMember, type OrgMember } from "@/lib/frontier/orgs"
import { fetchAccessibleProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { RoleLabel } from "@/components/RoleLabel"
import { RoleSelect } from "@/components/RoleSelect"
import {
  ALL_ROLE_LEVELS,
  ALL_ROLE_OPTIONS,
  ROLE,
  humanRoleName,
  roleDisplayText,
  roleHelpText,
  roleName,
} from "@/lib/frontier/roles"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { DateTooltip } from "@/components/ui/date-tooltip"

type TeamTab = "overview" | "projects" | "members"
type TeamMember = TeamDetailType["members"][number]
type TeamProject = TeamDetailType["projects"][number]

function roleLabel(roleLevel: number | null | undefined): string {
  if (roleLevel == null) return "Unknown"
  // Fall back to the canonical humanized name — never a raw numeric (FRO-368).
  return ALL_ROLE_LEVELS.includes(roleLevel as (typeof ALL_ROLE_LEVELS)[number])
    ? roleDisplayText(roleName(roleLevel))
    : humanRoleName(roleLevel)
}

// AQU-789: removing a team member is a maintainer+ (600) action. The row menu
// always includes Remove; without permission the item is disabled with this
// explanation instead of a missing control.
const REMOVE_REQUIRES_MAINTAINER_TOOLTIP =
  "Only maintainers and org owners can remove members from a team. Ask a maintainer to remove someone."

function lockedOrgRoleTooltip(roleLevel: number | null | undefined): string {
  const help = roleLevel != null ? roleHelpText(roleLevel) : ""
  const prefix = help || "This member's org-level role is unknown."
  return `${prefix} This permission is set at the org level and can only be changed by an org owner.`
}

function CopyEmailButton({ email }: { email: string }) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      className="max-w-full truncate text-left text-muted-foreground hover:text-foreground"
      aria-label={t("org.membersPage.orgTable.copyEmailAriaLabel", { email })}
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(email).then(() => {
          toast.add({ type: "success", title: "Email copied to clipboard" })
        })
      }}
    >
      {email}
    </button>
  )
}

export function TeamDetail() {
  const { t } = useI18n()
  const { groupId } = useParams<{ groupId: string }>()
  const groupIdNum = groupId != null ? Number(groupId) : null
  const { activeOrgId, activeOrg } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()

  const isAdmin = (activeOrg?.role.level ?? 0) >= 600
  // Only org owners (700+) can change org-level member roles (POST /orgs/:id/members upsert).
  const isOwner = (activeOrg?.role.level ?? 0) >= 700

  const [team, setTeam] = useState<TeamDetailType | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<TeamTab>("projects")
  useNavHistoryTitle(team?.name)

  // Org members for the add-member picker (admin only)
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([])

  // Org projects for the attach-project picker (admin only)
  const [orgProjects, setOrgProjects] = useState<CloudProjectSummary[]>([])

  // Attach project UI state
  const [attachingProject, setAttachingProject] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState("")
  const [selectedRole, setSelectedRole] = useState<number>(ROLE.VIEWER)

  // Add member UI state — multi-select (AQU-735): stage several org members via
  // MemberMultiSelect (same checkbox combobox as named validators) and grant
  // them all in one batch request.
  const [addingMember, setAddingMember] = useState(false)
  const [stagedUsernames, setStagedUsernames] = useState<string[]>([])
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  // Change-role dialog (owners only) — opened from the row actions menu.
  const [roleChangeTarget, setRoleChangeTarget] = useState<TeamMember | null>(null)
  const [roleChangeLevel, setRoleChangeLevel] = useState("")
  const [roleChangeBusy, setRoleChangeBusy] = useState(false)

  // Change team-grant role on an attached project — opened from the projects row menu.
  const [projectRoleTarget, setProjectRoleTarget] = useState<TeamProject | null>(null)
  const [projectRoleLevel, setProjectRoleLevel] = useState("")
  const [projectRoleBusy, setProjectRoleBusy] = useState(false)

  const refetch = useCallback(async () => {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    setLoading(true)
    try {
      const t = await getTeam(jwt, activeOrgId, groupIdNum)
      setTeam(t)
    } catch {
      setTeam(null)
    } finally {
      setLoading(false)
    }
  }, [jwt, activeOrgId, groupIdNum])

  useEffect(() => {
    void refetch()
  }, [refetch])

  // Load org members once for admin pickers
  useEffect(() => {
    if (!isAdmin || !jwt || activeOrgId == null) return
    listOrgMembers(jwt, activeOrgId).then(setOrgMembers).catch(() => {})
  }, [isAdmin, jwt, activeOrgId])

  // Load org projects once for admin attach picker
  useEffect(() => {
    if (!isAdmin || !jwt || activeOrgId == null) return
    fetchAccessibleProjects(jwt, activeOrgId).then(setOrgProjects).catch(() => {})
  }, [isAdmin, jwt, activeOrgId])

  // Only offer org members who are not already in this team, sorted for scanning.
  const availableOrgMembers = useMemo(
    () =>
      orgMembers
        .filter((member) => !team?.members.some((teamMember) => teamMember.userId === member.userId))
        .sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base" })),
    [orgMembers, team?.members],
  )

  const attachableProjects = useMemo(
    () => orgProjects.filter((op) => !team?.projects.some((tp) => tp.id === op.id)),
    [orgProjects, team?.projects],
  )

  function closeAddMember() {
    setAddingMember(false)
    setStagedUsernames([])
    setAddError(null)
  }

  async function handleAddMembers() {
    if (!jwt || activeOrgId == null || groupIdNum == null || stagedUsernames.length === 0) return
    setAddBusy(true)
    setAddError(null)
    try {
      // ONE batch request — the endpoint is non-atomic and returns per-person
      // results in request order, so one rejected person never sinks the rest.
      const results = await addTeamMembers(jwt, activeOrgId, groupIdNum, stagedUsernames)
      await refetch()
      const failures = results.filter((r) => !r.ok)
      if (failures.length === 0) {
        closeAddMember()
        return
      }
      // Keep only the people who failed staged for a retry; drop the successes.
      // Name each failure with its reason — no silent all-or-nothing.
      setStagedUsernames(failures.map((f) => f.username))
      setAddError(
        failures
          .map((f) => `${f.username} (${f.error?.message ?? "couldn't be added"})`)
          .join(", "),
      )
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Couldn't add members.")
    } finally {
      setAddBusy(false)
    }
  }

  const handleRemoveMember = useCallback(async (userId: number) => {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    await removeTeamMember(jwt, activeOrgId, groupIdNum, userId)
    await refetch()
  }, [jwt, activeOrgId, groupIdNum, refetch])

  function closeAttachProject() {
    setAttachingProject(false)
    setSelectedProjectId("")
    setSelectedRole(ROLE.VIEWER)
  }

  function openAttachProject() {
    setSelectedProjectId(attachableProjects[0]?.id ?? "")
    setSelectedRole(ROLE.VIEWER)
    setAttachingProject(true)
  }

  async function handleAttachProject() {
    if (!jwt || activeOrgId == null || groupIdNum == null || !selectedProjectId) return
    await attachProject(jwt, activeOrgId, groupIdNum, selectedProjectId, selectedRole)
    closeAttachProject()
    await refetch()
  }

  async function handleChangeProjectRole(projectId: string, roleLevel: number) {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    await changeProjectRole(jwt, activeOrgId, groupIdNum, projectId, roleLevel)
    await refetch()
  }

  const handleChangeMemberRole = useCallback(async (username: string, roleLevel: number) => {
    if (!jwt || activeOrgId == null) return
    await addOrgMember(jwt, activeOrgId, username, roleLevel)
    await refetch()
  }, [jwt, activeOrgId, refetch])

  function openRoleChange(member: TeamMember) {
    setRoleChangeTarget(member)
    setRoleChangeLevel(member.roleLevel != null ? String(member.roleLevel) : String(ROLE.VIEWER))
  }

  function closeRoleChange() {
    setRoleChangeTarget(null)
    setRoleChangeLevel("")
    setRoleChangeBusy(false)
  }

  async function confirmRoleChange() {
    if (!roleChangeTarget || !roleChangeLevel) return
    setRoleChangeBusy(true)
    try {
      await handleChangeMemberRole(roleChangeTarget.username, Number(roleChangeLevel))
      closeRoleChange()
    } finally {
      setRoleChangeBusy(false)
    }
  }

  function openProjectRoleChange(project: TeamProject) {
    setProjectRoleTarget(project)
    setProjectRoleLevel(String(project.grantedRoleLevel))
  }

  function closeProjectRoleChange() {
    setProjectRoleTarget(null)
    setProjectRoleLevel("")
    setProjectRoleBusy(false)
  }

  async function confirmProjectRoleChange() {
    if (!projectRoleTarget || !projectRoleLevel) return
    setProjectRoleBusy(true)
    try {
      await handleChangeProjectRole(projectRoleTarget.id, Number(projectRoleLevel))
      closeProjectRoleChange()
    } finally {
      setProjectRoleBusy(false)
    }
  }

  async function handleDetachProject(projectId: string) {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    await detachProject(jwt, activeOrgId, groupIdNum, projectId)
    await refetch()
  }

  const projectColumns = useMemo<ColumnDef<TeamProject>[]>(
    () => [
      {
        id: "name",
        accessorFn: (p) => p.name.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.name")} />,
        meta: { className: "min-w-0" },
        cell: ({ row }) => (
          <span className="block min-w-0 truncate font-medium">{row.original.name}</span>
        ),
      },
      {
        id: "role",
        accessorFn: (p) => p.grantedRoleLevel,
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.roleLabel")} />,
        meta: { className: "w-[7.5rem] whitespace-nowrap" },
        cell: ({ row }) => <RoleLabel name={row.original.grantedRoleLevel} />,
      },
      {
        id: "added",
        accessorFn: (p) => {
          const ts = p.grantedAt != null ? Date.parse(p.grantedAt) : Number.NaN
          return Number.isFinite(ts) ? ts : undefined
        },
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("org.teamDetail.addedColumn")} />
        ),
        meta: { className: "w-[7.5rem] whitespace-nowrap" },
        cell: ({ row }) => (
          <DateTooltip
            value={row.original.grantedAt}
            label={t("org.teamDetail.addedColumn")}
            className="text-sm text-muted-foreground"
          />
        ),
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">{t("org.overviewLaneTable.actionsColumn")}</span>,
        meta: { align: "right" as const, className: "w-10" },
        cell: ({ row }) => {
          const p = row.original
          if (!isAdmin) return null
          return (
            <DataTableRowActionsButton
              label={t("org.rowActionsAriaLabel", { name: p.name })}
              revealOnHover
            />
          )
        },
      },
    ],
    [isAdmin, t],
  )

  const memberColumns = useMemo<ColumnDef<TeamMember>[]>(
    () => [
      {
        id: "name",
        accessorFn: (m) => m.username.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.name")} />,
        meta: { className: "min-w-0" },
        cell: ({ row }) => (
          <UsernameWithAvatar username={row.original.username} size="xs" nameClassName="font-normal" />
        ),
      },
      {
        id: "email",
        accessorFn: (m) => missingLast((m.email ?? "").toLowerCase()),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.email")} />,
        meta: { className: "w-[13rem] max-w-[13rem]" },
        cell: ({ row }) => {
          const email = row.original.email?.trim()
          if (!email) {
            return <span className="text-muted-foreground">—</span>
          }
          return <CopyEmailButton email={email} />
        },
      },
      {
        id: "role",
        accessorFn: (m) => m.roleLevel ?? 0,
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.roleLabel")} />,
        meta: { className: "w-[7.5rem] whitespace-nowrap" },
        cell: ({ row }) => {
          const m = row.original
          if (m.roleLevel == null) {
            return <span className="text-sm text-muted-foreground">{t("autopilot.evidence.status.unknown")}</span>
          }

          const label = <RoleLabel name={m.roleLevel} />

          // Owners change roles via the actions menu dialog — badge is display-only.
          // Non-owners get a tooltip explaining the org-level lock.
          if (isOwner) return label

          return (
            <AppTooltip content={lockedOrgRoleTooltip(m.roleLevel)} className="max-w-xs">
              <span
                tabIndex={0}
                className="inline-flex cursor-help"
                aria-label={t("org.teamDetail.orgLevelRoleAriaLabel", { role: roleLabel(m.roleLevel) })}
              >
                {label}
              </span>
            </AppTooltip>
          )
        },
      },
      {
        id: "added",
        accessorFn: (m) => {
          const ts = m.addedAt != null ? Date.parse(m.addedAt) : Number.NaN
          return Number.isFinite(ts) ? ts : undefined
        },
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title={t("org.teamDetail.addedColumn")} />
        ),
        meta: { className: "w-[7.5rem] whitespace-nowrap" },
        cell: ({ row }) => (
          <DateTooltip
            value={row.original.addedAt}
            label={t("org.teamDetail.addedColumn")}
            className="text-sm text-muted-foreground"
          />
        ),
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">{t("org.overviewLaneTable.actionsColumn")}</span>,
        meta: { align: "right" as const, className: "w-10" },
        cell: ({ row }) => (
          <DataTableRowActionsButton
            label={t("org.rowActionsAriaLabel", { name: row.original.username })}
            revealOnHover
          />
        ),
      },
    ],
    [isOwner, t],
  )

  const teamDescription = team?.description?.trim() || null

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb parent={{ label: "Teams", to: activeOrgId != null ? orgPath(activeOrgId, "/teams") : "/orgs/all" }} section={team?.name ?? "Team"} />}
      statusBar={null}
      main={
        <Page size="wide">
          <div className="space-y-6">
            {loading ? (
              <>
                <div className="h-10 w-64 animate-pulse rounded-lg border bg-card" />
                <div className="h-8 w-72 animate-pulse rounded-lg border bg-card" />
                <div className="h-40 animate-pulse rounded-lg border bg-card" />
              </>
            ) : team == null ? (
              <EmptyState
                icon={NotFoundIcon}
                title={t("org.teamDetail.notFoundTitle")}
                description={t("org.teamDetail.notFoundDescription")}
              />
            ) : (
            <>
              {isOwner && (
                <Dialog
                  open={roleChangeTarget !== null}
                  onOpenChange={(open) => { if (!open) closeRoleChange() }}
                >
                  <DialogContent className="max-w-md">
                    <DialogHeader>
                      <DialogTitle>
                        {roleChangeTarget
                          ? t("org.teamDetail.changeRoleTitleFor", { name: roleChangeTarget.username })
                          : t("org.membersPage.changeRoleAria")}
                      </DialogTitle>
                      <DialogDescription>
                        {t("org.membersPage.orgTable.changeRoleDescription")}
                      </DialogDescription>
                    </DialogHeader>
                    <RoleSelect
                      options={ALL_ROLE_OPTIONS}
                      value={roleChangeLevel ? Number(roleChangeLevel) : null}
                      onValueChange={(level) => setRoleChangeLevel(String(level))}
                      className="w-full!"
                      aria-label={
                        roleChangeTarget
                          ? `Role for ${roleChangeTarget.username}`
                          : "New role"
                      }
                    />
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={closeRoleChange} disabled={roleChangeBusy}>
                        {t("common.cancel")}
                      </Button>
                      <Button
                        type="button"
                        onClick={() => void confirmRoleChange()}
                        disabled={!roleChangeLevel || roleChangeBusy}
                      >
                        {roleChangeBusy && <Spinner data-icon="inline-start" />}
                        {roleChangeBusy ? "Saving…" : "Save"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}

              {isAdmin && (
                <Dialog
                  open={projectRoleTarget !== null}
                  onOpenChange={(open) => { if (!open) closeProjectRoleChange() }}
                >
                  <DialogContent className="max-w-md">
                    <DialogHeader>
                      <DialogTitle>
                        {projectRoleTarget
                          ? t("org.teamDetail.changeRoleTitleFor", { name: projectRoleTarget.name })
                          : t("org.membersPage.changeRoleAria")}
                      </DialogTitle>
                      <DialogDescription>
                        {t("org.teamDetail.projectRoleDialogDescription")}
                      </DialogDescription>
                    </DialogHeader>
                    <RoleSelect
                      options={ALL_ROLE_OPTIONS}
                      value={projectRoleLevel ? Number(projectRoleLevel) : null}
                      onValueChange={(level) => setProjectRoleLevel(String(level))}
                      className="w-full!"
                      aria-label={
                        projectRoleTarget
                          ? `Role for ${projectRoleTarget.name}`
                          : "Granted role"
                      }
                    />
                    <DialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={closeProjectRoleChange}
                        disabled={projectRoleBusy}
                      >
                        {t("common.cancel")}
                      </Button>
                      <Button
                        type="button"
                        onClick={() => void confirmProjectRoleChange()}
                        disabled={!projectRoleLevel || projectRoleBusy}
                      >
                        {projectRoleBusy && <Spinner data-icon="inline-start" />}
                        {projectRoleBusy ? "Saving…" : "Save"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}

              {/* Avatar bleeds left of the max-w-6xl well so title/tabs/tables keep the same
                  content width as the teams list. Out of flow — do not pad the Page well. */}
              <div className="space-y-3">
              <div
                className={cn(
                  "relative flex justify-between gap-4",
                  teamDescription ? "items-start" : "items-center",
                )}
              >
                <span
                  aria-hidden
                  data-testid="team-detail-avatar"
                  className={cn(
                    "absolute right-full mr-3",
                    teamDescription ? "top-0 mt-0.5" : "top-1/2 -translate-y-1/2",
                  )}
                >
                  <InitialsAvatar name={team.name} size="default" />
                </span>
                <div className={cn("min-w-0", teamDescription && "space-y-1")}>
                  <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">
                    {team.name}
                  </h1>
                  {teamDescription ? (
                    <p className="max-w-prose text-sm text-muted-foreground whitespace-pre-wrap">
                      {teamDescription}
                    </p>
                  ) : null}
                </div>
                {isAdmin && activeOrgId != null && groupIdNum != null ? (
                  <Link
                    to={teamSettingsPath(activeOrgId, groupIdNum)}
                    aria-label={t("org.teamDetail.teamSettingsAriaLabel")}
                    className={cn(buttonVariants({ variant: "outline", size: "icon" }), "shrink-0")}
                  >
                    <Settings />
                  </Link>
                ) : null}
              </div>

              <Tabs
                value={tab}
                onValueChange={(v) => setTab((v as TeamTab) ?? "projects")}
                className="gap-4"
              >
                <TabsList aria-label={t("org.teamDetail.sectionsAriaLabel")}>
                  <TabsTrigger value="projects">{t("nav.projects")}</TabsTrigger>
                  <TabsTrigger value="members">{t("editor.navTitle.members")}</TabsTrigger>
                  <TabsTrigger value="overview" disabled>
                    {t("editor.navTitle.overview")}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="overview" />

                <TabsContent value="projects" className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-heading text-base font-medium text-foreground">{t("nav.projects")}</h2>
                      <p className="text-sm text-muted-foreground">
                        {t("org.teamDetail.projectsTabDescription")}
                      </p>
                    </div>
                  </div>

                  {isAdmin && (
                    <Dialog
                      open={attachingProject}
                      onOpenChange={(o) => { if (!o) closeAttachProject() }}
                    >
                      <DialogContent className="max-w-md gap-4">
                        <DialogHeader>
                          <DialogTitle>
                            {t("org.teamDetail.attachProjectDialogTitle", { name: team.name })}
                          </DialogTitle>
                          <DialogDescription>
                            {t("org.teamDetail.attachProjectDialogDescription")}
                          </DialogDescription>
                        </DialogHeader>
                        <div className="flex w-full flex-col gap-3">
                          <Select
                            items={attachableProjects.map((op) => ({ value: op.id, label: op.name }))}
                            value={selectedProjectId}
                            onValueChange={(v) => setSelectedProjectId(v ?? "")}
                          >
                            <SelectTrigger aria-label={t("org.teamDetail.projectToAttachAriaLabel")} className="w-full">
                              <SelectValue placeholder={t("org.teamDetail.selectProjectPlaceholder")} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {attachableProjects.map((op) => (
                                  <SelectItem key={op.id} value={op.id}>{op.name}</SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                          <RoleSelect
                            options={ALL_ROLE_OPTIONS}
                            value={selectedRole}
                            onValueChange={setSelectedRole}
                            aria-label={t("org.teamDetail.grantedRoleAriaLabel")}
                            className="w-full"
                          />
                          {attachableProjects.length === 0 && (
                            <p className="text-xs text-muted-foreground">
                              {t("org.teamDetail.allProjectsAttachedNotice")}
                            </p>
                          )}
                        </div>
                        <DialogFooter className="mt-0">
                          <Button type="button" variant="outline" onClick={closeAttachProject}>
                            {t("common.cancel")}
                          </Button>
                          <Button
                            type="button"
                            onClick={handleAttachProject}
                            disabled={!selectedProjectId}
                          >
                            {t("editor.media.attach")}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}

                  <DataTable
                      columns={projectColumns}
                      data={team.projects}
                      getRowId={(p) => p.id}
                      initialSorting={[{ id: "name", desc: false }]}
                      searchPlaceholder="Search by name"
                      globalFilterFn={(row, _columnId, filterValue) => {
                        const q = String(filterValue).trim().toLowerCase()
                        if (!q) return true
                        return row.original.name.toLowerCase().includes(q)
                      }}
                      toolbar={
                        isAdmin ? (
                          <Button
                            type="button"
                            className="ml-auto shrink-0"
                            onClick={openAttachProject}
                          >
                            {t("org.teamDetail.attachProjectButton")}
                          </Button>
                        ) : null
                      }
                      rowClassName="group"
                      onRowClick={(p) => navigate(`/projects/${p.id}`)}
                      renderRowMenuItems={(p) =>
                        isAdmin ? (
                          <>
                            <MenuItem onClick={() => openProjectRoleChange(p)}>
                              <ShieldUser className="size-4" />
                              {t("org.membersPage.changeRoleAria")}
                            </MenuItem>
                            <MenuSeparator />
                            <MenuItem
                              aria-label={t("org.teamDetail.detachAriaLabel", { name: p.name })}
                              onClick={() => void handleDetachProject(p.id)}
                            >
                              <Unlink className="size-4" />
                              {t("org.teamDetail.detachButton")}
                            </MenuItem>
                          </>
                        ) : null
                      }
                      emptyState={
                        team.projects.length === 0 ? (
                          <TableEmptyState
                            icon={FolderGit2}
                            title={t("org.teamDetail.noProjectsTitle")}
                            description={isAdmin ? t("org.teamDetail.noProjectsAdminDescription") : undefined}
                          />
                        ) : (
                          <p className="py-10 text-center text-sm text-muted-foreground">
                            {t("org.teamDetail.noProjectsMatchSearch")}
                          </p>
                        )
                      }
                      testId="team-projects-table"
                      className={ADMIN_TABLE_PANEL_CLASS}
                      dense
                    />
                </TabsContent>

                <TabsContent value="members" className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-heading text-base font-medium text-foreground">
                        {t("editor.navTitle.members")}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        {t("org.teamDetail.membersTabDescription")}
                      </p>
                    </div>
                  </div>

                  {isAdmin && (
                    <Dialog open={addingMember} onOpenChange={(o) => { if (!o) closeAddMember() }}>
                      <DialogContent className="max-w-md gap-4">
                        <DialogHeader>
                          <DialogTitle>
                            {t("org.teamDetail.addMembersDialogTitle", { name: team.name })}
                          </DialogTitle>
                        </DialogHeader>
                        <div className="flex w-full flex-col gap-2">
                          <div className="w-full">
                            <MemberMultiSelect
                              id="team-add-members"
                              aria-label={t("org.teamDetail.membersToAddAriaLabel")}
                              className="w-full!"
                              members={availableOrgMembers.map((m) => m.username)}
                              value={stagedUsernames}
                              disabled={availableOrgMembers.length === 0}
                              placeholder={t("org.teamDetail.selectMembersPlaceholder")}
                              searchPlaceholder="Search members…"
                              searchLabel="Search members"
                              emptyMessage={t("org.teamDetail.noMembersMatch")}
                              onValueChange={(next) => {
                                setAddError(null)
                                setStagedUsernames(next)
                              }}
                            />
                          </div>
                          {availableOrgMembers.length === 0 && stagedUsernames.length === 0 && (
                            <p className="text-xs text-muted-foreground">
                              {t("org.teamDetail.allMembersAddedNotice")}
                            </p>
                          )}
                          {addError && (
                            <p role="alert" className="text-xs text-destructive">
                              {t("org.teamDetail.addErrorPrefix", { error: addError })}
                            </p>
                          )}
                        </div>
                        <DialogFooter className="mt-0">
                          <Button type="button" variant="outline" onClick={closeAddMember}>
                            {t("common.cancel")}
                          </Button>
                          <Button
                            type="button"
                            onClick={handleAddMembers}
                            disabled={stagedUsernames.length === 0 || addBusy}
                          >
                            {addBusy && <Spinner data-icon="inline-start" />}
                            {addBusy ? "Adding…" : "Add"}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}

                  <DataTable
                      columns={memberColumns}
                      data={team.members}
                      getRowId={(m) => String(m.userId)}
                      initialSorting={[{ id: "name", desc: false }]}
                      searchPlaceholder="Search by name or email"
                      globalFilterFn={(row, _columnId, filterValue) => {
                        const q = String(filterValue).trim().toLowerCase()
                        if (!q) return true
                        const m = row.original
                        return (
                          m.username.toLowerCase().includes(q) ||
                          (m.email?.toLowerCase().includes(q) ?? false)
                        )
                      }}
                      toolbar={
                        isAdmin ? (
                          <Button
                            className="ml-auto shrink-0"
                            onClick={() => { setAddingMember(true); setStagedUsernames([]); setAddError(null) }}
                          >
                            {t("org.membersPage.orgTable.addMemberTitle")}
                          </Button>
                        ) : null
                      }
                      rowClassName="group"
                      renderRowMenuItems={(m) => (
                        <>
                          {isOwner && (
                            <>
                              <MenuItem onClick={() => openRoleChange(m)}>
                                <ShieldUser className="size-4" />
                                {t("org.membersPage.changeRoleAria")}
                              </MenuItem>
                              <MenuSeparator />
                            </>
                          )}
                          <DisabledFieldTooltip
                            disabled={!isAdmin}
                            tooltip={REMOVE_REQUIRES_MAINTAINER_TOOLTIP}
                          >
                            <MenuItem
                              aria-label={
                                isAdmin
                                  ? undefined
                                  : t("org.teamDetail.removeMaintainersOnlyAriaLabel", { username: m.username })
                              }
                              disabled={!isAdmin}
                              onClick={() => {
                                if (isAdmin) void handleRemoveMember(m.userId)
                              }}
                            >
                              <UserMinus className="size-4" />
                              {t("org.teamDetail.removeFromTeamButton")}
                            </MenuItem>
                          </DisabledFieldTooltip>
                        </>
                      )}
                      emptyState={
                        team.members.length === 0 ? (
                          <TableEmptyState
                            icon={Users}
                            title={t("org.teamDetail.noMembersTitle")}
                            description={isAdmin ? t("org.teamDetail.noMembersAdminDescription") : undefined}
                          />
                        ) : (
                          <p className="py-10 text-center text-sm text-muted-foreground">
                            {t("org.membersPage.orgTable.noSearchMatch")}
                          </p>
                        )
                      }
                      testId="team-members-table"
                      className={ADMIN_TABLE_PANEL_CLASS}
                      dense
                    />
                </TabsContent>
              </Tabs>
              </div>
            </>
            )}
          </div>
        </Page>
      }
    />
  )
}

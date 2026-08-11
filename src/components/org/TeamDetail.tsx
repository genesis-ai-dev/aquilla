import { useCallback, useEffect, useMemo, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { Link, useNavigate, useParams } from "react-router-dom"
import { FolderGit2, Settings, UserPlus, Users } from "lucide-react"
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
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { Page, EmptyState } from "@/components/ui/page"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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

// AQU-789: removing a team member is a maintainer+ (600) action. Non-maintainers
// who can view a team see this on a disabled Remove control instead of nothing.
const REMOVE_REQUIRES_MAINTAINER_TOOLTIP =
  "Only maintainers and org owners can remove members from a team. Ask a maintainer to remove someone."

function lockedOrgRoleTooltip(roleLevel: number | null | undefined): string {
  const help = roleLevel != null ? roleHelpText(roleLevel) : ""
  const prefix = help || "This member's org-level role is unknown."
  return `${prefix} This permission is set at the org level and can only be changed by an org owner.`
}

function CopyEmailButton({ email }: { email: string }) {
  return (
    <button
      type="button"
      className="max-w-full truncate text-left text-muted-foreground hover:text-foreground"
      aria-label={`Copy ${email}`}
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

  async function handleAttachProject() {
    if (!jwt || activeOrgId == null || groupIdNum == null || !selectedProjectId) return
    await attachProject(jwt, activeOrgId, groupIdNum, selectedProjectId, selectedRole)
    setAttachingProject(false)
    setSelectedProjectId("")
    setSelectedRole(ROLE.VIEWER)
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
        header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
        meta: { className: "min-w-0" },
        cell: ({ row }) => (
          <span className="block min-w-0 truncate font-medium">{row.original.name}</span>
        ),
      },
      {
        id: "role",
        accessorFn: (p) => p.grantedRoleLevel,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
        meta: { className: "w-[7.5rem] whitespace-nowrap" },
        cell: ({ row }) => (
          <span className="text-sm text-foreground">
            {roleLabel(row.original.grantedRoleLevel)}
          </span>
        ),
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        meta: { align: "right" as const, className: "w-10" },
        cell: ({ row }) => {
          const p = row.original
          if (!isAdmin) return null
          return (
            <DataTableRowActionsButton
              label={`Actions for ${p.name}`}
              revealOnHover
            />
          )
        },
      },
    ],
    [isAdmin],
  )

  const memberColumns = useMemo<ColumnDef<TeamMember>[]>(
    () => [
      {
        id: "name",
        accessorFn: (m) => m.username.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
        meta: { className: "min-w-0" },
        cell: ({ row }) => (
          <UsernameWithAvatar username={row.original.username} size="xs" nameClassName="font-normal" />
        ),
      },
      {
        id: "email",
        accessorFn: (m) => missingLast((m.email ?? "").toLowerCase()),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Email" />,
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
        header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
        meta: { className: "w-[7.5rem] whitespace-nowrap" },
        cell: ({ row }) => {
          const m = row.original
          if (m.roleLevel == null) {
            return <span className="text-sm text-muted-foreground">Unknown</span>
          }

          const label = (
            <span className="text-sm text-foreground">{roleLabel(m.roleLevel)}</span>
          )

          // Owners change roles via the actions menu dialog — text is display-only.
          // Non-owners get a tooltip explaining the org-level lock.
          if (isOwner) return label

          return (
            <AppTooltip content={lockedOrgRoleTooltip(m.roleLevel)} className="max-w-xs">
              <span
                tabIndex={0}
                className="inline-flex cursor-help"
                aria-label={`Org-level role: ${roleLabel(m.roleLevel)}`}
              >
                {label}
              </span>
            </AppTooltip>
          )
        },
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        meta: { align: "right" as const, className: "w-10" },
        cell: ({ row }) => {
          const m = row.original
          if (!isAdmin) {
            /* AQU-789: removing a team member is a maintainer+ action. Show a
               disabled control with the reason rather than omitting it, so it
               doesn't read as a missing feature. */
            return (
              <AppTooltip content={REMOVE_REQUIRES_MAINTAINER_TOOLTIP} className="max-w-xs">
                <span
                  tabIndex={0}
                  aria-disabled="true"
                  aria-label={`Remove ${m.username} — maintainers only`}
                  className="inline-flex cursor-not-allowed items-center text-xs text-muted-foreground/70 underline decoration-dotted"
                >
                  Remove
                </span>
              </AppTooltip>
            )
          }
          return (
            <DataTableRowActionsButton
              label={`Actions for ${m.username}`}
              revealOnHover
            />
          )
        },
      },
    ],
    [isAdmin],
  )

  const teamDescription = team?.description?.trim() || null

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb parent={{ label: "Teams", to: activeOrgId != null ? orgPath(activeOrgId, "/teams") : "/orgs/all" }} section={team?.name ?? "Team"} />}
      statusBar={null}
      main={
        <Page size="wide" className="pl-14 sm:pl-16">
          <div className="space-y-6">
            {loading ? (
              <>
                <div className="h-10 w-64 animate-pulse rounded-lg border bg-card" />
                <div className="h-8 w-72 animate-pulse rounded-lg border bg-card" />
                <div className="h-40 animate-pulse rounded-lg border bg-card" />
              </>
            ) : team == null ? (
              <EmptyState title="Team not found." description="This team may have been deleted, or you may not have access to it." />
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
                        Change role{roleChangeTarget ? ` for ${roleChangeTarget.username}` : ""}
                      </DialogTitle>
                      <DialogDescription>
                        This updates their organization-level role across every project.
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
                        Cancel
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
                        Change role{projectRoleTarget ? ` for ${projectRoleTarget.name}` : ""}
                      </DialogTitle>
                      <DialogDescription>
                        Team members inherit this role on the project through the team grant.
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
                        Cancel
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

              {/* Avatar hangs left of the content column so title/description/tabs share one left edge.
                  With no description, omit the <p> entirely and center the title on the avatar. */}
              <div className="space-y-3">
              <div
                className={cn(
                  "flex justify-between gap-4",
                  teamDescription ? "items-start" : "items-center",
                )}
              >
                <div
                  className={cn(
                    "-ml-11 flex min-w-0 gap-3",
                    teamDescription ? "items-start" : "items-center",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn("shrink-0", teamDescription && "mt-0.5")}
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
                </div>
                {isAdmin && activeOrgId != null && groupIdNum != null ? (
                  <Link
                    to={teamSettingsPath(activeOrgId, groupIdNum)}
                    aria-label="Team settings"
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
                <TabsList aria-label="Team sections">
                  <TabsTrigger value="projects">Projects</TabsTrigger>
                  <TabsTrigger value="members">Members</TabsTrigger>
                  <TabsTrigger value="overview" disabled>
                    Overview
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="overview" />

                <TabsContent value="projects" className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-heading text-base font-medium text-foreground">Projects</h2>
                      <p className="text-sm text-muted-foreground">
                        Projects this team can access, and the role granted to members.
                      </p>
                    </div>
                  </div>

                  {isAdmin && attachingProject && (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
                      <Select
                        items={orgProjects
                          .filter((op) => !team.projects.some((tp) => tp.id === op.id))
                          .map((op) => ({ value: op.id, label: op.name }))}
                        value={selectedProjectId}
                        onValueChange={(v) => setSelectedProjectId(v ?? "")}
                      >
                        <SelectTrigger aria-label="Project to attach">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {orgProjects
                              .filter((op) => !team.projects.some((tp) => tp.id === op.id))
                              .map((op) => (
                                <SelectItem key={op.id} value={op.id}>{op.name}</SelectItem>
                              ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <RoleSelect
                        options={ALL_ROLE_OPTIONS}
                        value={selectedRole}
                        onValueChange={setSelectedRole}
                        aria-label="Granted role"
                      />
                      <Button type="button" onClick={handleAttachProject}>Attach</Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => { setAttachingProject(false); setSelectedProjectId("") }}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}

                  {team.projects.length === 0 ? (
                    <div className="space-y-4">
                      {isAdmin && !attachingProject && (
                        <div className="flex justify-end">
                          <Button
                            type="button"
                            variant="outline"
                            className="shrink-0"
                            onClick={() => {
                              const attachableProjects = orgProjects.filter(
                                (op) => !team.projects.some((tp) => tp.id === op.id),
                              )
                              setSelectedProjectId(attachableProjects[0]?.id ?? "")
                              setSelectedRole(ROLE.VIEWER)
                              setAttachingProject(true)
                            }}
                          >
                            Attach project
                          </Button>
                        </div>
                      )}
                      <EmptyState
                        variant="inline"
                        icon={FolderGit2}
                        title="No projects."
                        description={isAdmin ? "Attach a project to grant this team access at a chosen role." : undefined}
                      />
                    </div>
                  ) : (
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
                        isAdmin && !attachingProject ? (
                          <Button
                            type="button"
                            variant="outline"
                            className="ml-auto shrink-0"
                            onClick={() => {
                              const attachableProjects = orgProjects.filter(
                                (op) => !team.projects.some((tp) => tp.id === op.id),
                              )
                              setSelectedProjectId(attachableProjects[0]?.id ?? "")
                              setSelectedRole(ROLE.VIEWER)
                              setAttachingProject(true)
                            }}
                          >
                            Attach project
                          </Button>
                        ) : null
                      }
                      rowClassName="group"
                      onRowClick={(p) => navigate(`/projects/${p.id}`)}
                      renderRowContextMenu={(p) =>
                        isAdmin ? (
                          <ContextMenuContent className="min-w-40">
                            <ContextMenuItem onClick={() => openProjectRoleChange(p)}>
                              Change role
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              aria-label={`Detach ${p.name}`}
                              onClick={() => void handleDetachProject(p.id)}
                            >
                              Detach
                            </ContextMenuItem>
                          </ContextMenuContent>
                        ) : null
                      }
                      emptyState={
                        <p className="py-10 text-center text-sm text-muted-foreground">
                          No projects match this search.
                        </p>
                      }
                      testId="team-projects-table"
                      className={ADMIN_TABLE_PANEL_CLASS}
                      dense
                    />
                  )}
                </TabsContent>

                <TabsContent value="members" className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-heading text-base font-medium text-foreground">
                        Members
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        People on this team inherit its project grants at their org role.
                      </p>
                    </div>
                  </div>

                  {isAdmin && (
                    <Dialog open={addingMember} onOpenChange={(o) => { if (!o) closeAddMember() }}>
                      <DialogContent className="max-w-md gap-4">
                        <DialogHeader>
                          <DialogTitle>Add members to &apos;{team.name}&apos;</DialogTitle>
                        </DialogHeader>
                        <div className="flex w-full flex-col gap-2">
                          <div className="w-full">
                            <MemberMultiSelect
                              id="team-add-members"
                              aria-label="Members to add"
                              className="w-full!"
                              members={availableOrgMembers.map((m) => m.username)}
                              value={stagedUsernames}
                              disabled={availableOrgMembers.length === 0}
                              placeholder="Select members…"
                              searchPlaceholder="Search members…"
                              searchLabel="Search members"
                              emptyMessage="No available members match."
                              onValueChange={(next) => {
                                setAddError(null)
                                setStagedUsernames(next)
                              }}
                            />
                          </div>
                          {availableOrgMembers.length === 0 && stagedUsernames.length === 0 && (
                            <p className="text-xs text-muted-foreground">
                              All org members are already in this team.
                            </p>
                          )}
                          {addError && (
                            <p role="alert" className="text-xs text-destructive">
                              Couldn&apos;t add: {addError}
                            </p>
                          )}
                        </div>
                        <DialogFooter className="mt-0">
                          <Button type="button" variant="outline" onClick={closeAddMember}>
                            Cancel
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

                  {team.members.length === 0 ? (
                    <div className="space-y-4">
                      {isAdmin && (
                        <div className="flex justify-end">
                          <Button
                            type="button"
                            className="gap-1.5"
                            onClick={() => { setAddingMember(true); setStagedUsernames([]); setAddError(null) }}
                          >
                            <UserPlus className="size-3.5" />
                            Add a member
                          </Button>
                        </div>
                      )}
                      <EmptyState
                        variant="inline"
                        icon={Users}
                        title="No members."
                        description={isAdmin ? "Add org members to this team to grant them shared project access." : undefined}
                      />
                    </div>
                  ) : (
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
                            className="ml-auto shrink-0 gap-1.5"
                            onClick={() => { setAddingMember(true); setStagedUsernames([]); setAddError(null) }}
                          >
                            <UserPlus className="size-4" />
                            Add a member
                          </Button>
                        ) : null
                      }
                      rowClassName="group"
                      renderRowContextMenu={(m) =>
                        isAdmin ? (
                          <ContextMenuContent className="min-w-40">
                            {isOwner && (
                              <>
                                <ContextMenuItem onClick={() => openRoleChange(m)}>
                                  Change role
                                </ContextMenuItem>
                                <ContextMenuSeparator />
                              </>
                            )}
                            <ContextMenuItem onClick={() => void handleRemoveMember(m.userId)}>
                              Remove from team
                            </ContextMenuItem>
                          </ContextMenuContent>
                        ) : null
                      }
                      emptyState={
                        <p className="py-10 text-center text-sm text-muted-foreground">
                          No members match this search.
                        </p>
                      }
                      testId="team-members-table"
                      className={ADMIN_TABLE_PANEL_CLASS}
                      dense
                    />
                  )}
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

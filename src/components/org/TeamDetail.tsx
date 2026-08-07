import { useCallback, useEffect, useMemo, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { type ColumnDef } from "@tanstack/react-table"
import { z } from "zod"
import { useNavigate, useParams } from "react-router-dom"
import { FolderGit2, MoreHorizontal, UserPlus, Users } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { MemberMultiSelect } from "@/components/MemberMultiSelect"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"
import { Button } from "@/components/ui/button"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { Page, EmptyState } from "@/components/ui/page"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AppTooltip } from "@/components/ui/tooltip"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { orgPath } from "@/lib/navigation/org-paths"
import {
  getTeam,
  addTeamMembers,
  removeTeamMember,
  deleteTeam,
  updateTeam,
  attachProject,
  changeProjectRole,
  detachProject,
  type TeamDetail as TeamDetailType,
} from "@/lib/frontier/teams"
import { listOrgMembers, addOrgMember, type OrgMember } from "@/lib/frontier/orgs"
import { fetchAccessibleProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { optionalString, requiredString } from "@/lib/forms/schemas"
import { useSubmitError } from "@/lib/forms/submit-error"
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

const editTeamSchema = z.object({
  name: requiredString("Team name"),
  description: optionalString,
})

type TeamTab = "overview" | "projects" | "members"
type TeamMember = TeamDetailType["members"][number]

function roleLabel(roleLevel: number | null | undefined): string {
  if (roleLevel == null) return "Unknown"
  // Fall back to the canonical humanized name — never a raw numeric (FRO-368).
  return ALL_ROLE_LEVELS.includes(roleLevel as (typeof ALL_ROLE_LEVELS)[number])
    ? roleDisplayText(roleName(roleLevel))
    : humanRoleName(roleLevel)
}

function lockedOrgRoleTooltip(roleLevel: number | null | undefined): string {
  const help = roleLevel != null ? roleHelpText(roleLevel) : ""
  const prefix = help || "This member's org-level role is unknown."
  return `${prefix} This permission is set at the org level and can only be changed by an org owner.`
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
  const [tab, setTab] = useState<TeamTab>("overview")

  // Org members for the add-member picker (admin only)
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([])

  // Org projects for the attach-project picker (admin only)
  const [orgProjects, setOrgProjects] = useState<CloudProjectSummary[]>([])

  // Attach project UI state
  const [attachingProject, setAttachingProject] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState("")
  const [selectedRole, setSelectedRole] = useState<number>(ROLE.VIEWER)

  // Edit state
  const [editing, setEditing] = useState(false)
  const { submitError: editSubmitError, setSubmitError: setEditSubmitError, clearSubmitError: clearEditSubmitError } = useSubmitError()

  const editTeamForm = useForm({
    defaultValues: { name: "", description: "" },
    validators: { onSubmit: editTeamSchema },
    onSubmit: async ({ value }) => {
      if (!jwt || activeOrgId == null || groupIdNum == null) return
      clearEditSubmitError()
      const patch: { name: string; description?: string } = { name: value.name.trim() }
      if (team?.description !== undefined || value.description.trim() !== "") {
        patch.description = value.description.trim()
      }
      try {
        await updateTeam(jwt, activeOrgId, groupIdNum, patch)
        setEditing(false)
        await refetch()
      } catch (err) {
        setEditSubmitError(err instanceof Error ? err.message : "Couldn't save team.")
      }
    },
  })

  // Delete confirm state
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

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

  async function handleDelete() {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    setDeleting(true)
    try {
      await deleteTeam(jwt, activeOrgId, groupIdNum)
      navigate(orgPath(activeOrgId, "/teams"))
    } finally {
      setDeleting(false)
    }
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

  async function handleDetachProject(projectId: string) {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    await detachProject(jwt, activeOrgId, groupIdNum, projectId)
    await refetch()
  }

  function handleEditOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      editTeamForm.reset()
      clearEditSubmitError()
    }
    setEditing(nextOpen)
  }

  function handleEditOpen() {
    editTeamForm.setFieldValue("name", team?.name ?? "")
    editTeamForm.setFieldValue("description", team?.description ?? "")
    clearEditSubmitError()
    setEditing(true)
  }

  const memberColumns = useMemo<ColumnDef<TeamMember>[]>(
    () => [
      {
        id: "name",
        accessorFn: (m) => m.username.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
        meta: { className: "min-w-0 w-[50%]" },
        cell: ({ row }) => (
          <UsernameWithAvatar username={row.original.username} size="xs" nameClassName="font-normal" />
        ),
      },
      {
        id: "email",
        accessorFn: (m) => (m.email ?? "").toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Email" />,
        meta: { className: "min-w-0 w-[35%]" },
        cell: ({ row }) => (
          <span className="block truncate text-muted-foreground">
            {row.original.email?.trim() ? row.original.email : "—"}
          </span>
        ),
      },
      {
        id: "role",
        accessorFn: (m) => m.roleLevel ?? 0,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
        meta: { className: "w-0 whitespace-nowrap" },
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
          if (!isAdmin) return null
          return (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 opacity-0 transition-none group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
                    aria-label={`Actions for ${m.username}`}
                  >
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="min-w-40">
                {isOwner && (
                  <DropdownMenuItem onClick={() => openRoleChange(m)}>
                    Change role
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => void handleRemoveMember(m.userId)}
                >
                  Remove {m.username}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        },
      },
    ],
    [handleRemoveMember, isAdmin, isOwner],
  )

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
              {isAdmin && (
                <Dialog open={editing} onOpenChange={handleEditOpenChange}>
                  <DialogContent className="max-w-md">
                    <DialogHeader>
                      <DialogTitle>Edit team</DialogTitle>
                    </DialogHeader>
                    <form
                      id="edit-team-form"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void editTeamForm.handleSubmit()
                      }}
                    >
                      <FieldGroup>
                        <editTeamForm.Field
                          name="name"
                          children={(field) => {
                            const invalid = isFieldInvalid(field)
                            return (
                              <Field data-invalid={invalid}>
                                <FieldLabel htmlFor="edit-team-name">Team name</FieldLabel>
                                <Input
                                  id="edit-team-name"
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
                        <editTeamForm.Field
                          name="description"
                          children={(field) => (
                            <Field>
                              <FieldLabel htmlFor="edit-team-desc">Description (optional)</FieldLabel>
                              <Input
                                id="edit-team-desc"
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
                      {editSubmitError && (
                        <FieldError role="alert" className="mt-3">
                          {editSubmitError}
                        </FieldError>
                      )}
                    </form>
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={() => handleEditOpenChange(false)}>
                        Cancel
                      </Button>
                      <Button type="submit" form="edit-team-form">
                        {editTeamForm.state.isSubmitting && <Spinner data-icon="inline-start" />}
                        {editTeamForm.state.isSubmitting ? "Saving…" : "Save"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}

              {isAdmin && (
                <Dialog open={confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(false) }}>
                  <DialogContent className="max-w-md">
                    <DialogHeader>
                      <DialogTitle>Delete &apos;{team.name}&apos;?</DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-muted-foreground">
                      This removes the team and all its grants.
                    </p>
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                        Cancel
                      </Button>
                      <Button type="button" variant="destructive" onClick={handleDelete} disabled={deleting}>
                        {deleting ? "Deleting…" : "Confirm"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}

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

              {/* Avatar hangs left of the content column so title/description/tabs share one left edge. */}
              <div className="mb-6 flex items-start justify-between gap-4 sm:mb-8">
                <div className="-ml-11 flex min-w-0 items-start gap-3">
                  <span aria-hidden className="mt-0.5 shrink-0">
                    <InitialsAvatar name={team.name} size="default" />
                  </span>
                  <div className="min-w-0 space-y-1">
                    <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">
                      {team.name}
                    </h1>
                    {team.description?.trim() ? (
                      <p className="max-w-prose text-sm text-muted-foreground whitespace-pre-wrap">
                        {team.description}
                      </p>
                    ) : null}
                  </div>
                </div>
                {isAdmin ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleEditOpen}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => setConfirmDelete(true)}
                    >
                      Delete team
                    </Button>
                  </div>
                ) : null}
              </div>

              <Tabs
                value={tab}
                onValueChange={(v) => setTab((v as TeamTab) ?? "overview")}
                className="gap-4"
              >
                <TabsList aria-label="Team sections">
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="projects">Projects</TabsTrigger>
                  <TabsTrigger value="members">Members</TabsTrigger>
                </TabsList>

                <TabsContent value="overview" />

                <TabsContent value="projects" className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-heading text-base font-medium text-foreground">Projects</h2>
                      <p className="text-sm text-muted-foreground">
                        Projects this team can access, and the role granted to members.
                      </p>
                    </div>
                    {isAdmin && !attachingProject ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => {
                          const teamProjects = team.projects
                          const attachableProjects = orgProjects.filter(
                            (op) => !teamProjects.some((tp) => tp.id === op.id),
                          )
                          setSelectedProjectId(attachableProjects[0]?.id ?? "")
                          setSelectedRole(ROLE.VIEWER)
                          setAttachingProject(true)
                        }}
                      >
                        Attach project
                      </Button>
                    ) : null}
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
                    <EmptyState
                      variant="inline"
                      icon={FolderGit2}
                      title="No projects."
                      description={isAdmin ? "Attach a project to grant this team access at a chosen role." : undefined}
                    />
                  ) : (
                    <ul className="overflow-hidden rounded-lg border bg-card divide-y">
                      {team.projects.map((p) => (
                        <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                          <button
                            type="button"
                            className="min-w-0 truncate text-left font-medium hover:underline"
                            onClick={() => navigate(`/projects/${p.id}`)}
                          >
                            {p.name}
                          </button>
                          <div className="flex shrink-0 items-center gap-2">
                            {isAdmin ? (
                              <>
                                <RoleSelect
                                  options={ALL_ROLE_OPTIONS}
                                  value={p.grantedRoleLevel}
                                  onValueChange={(level) => void handleChangeProjectRole(p.id, level)}
                                  size="sm"
                                  className="text-xs"
                                  aria-label={`Role for ${p.name}`}
                                />
                                <button
                                  type="button"
                                  className="text-xs text-destructive underline"
                                  aria-label={`Detach ${p.name}`}
                                  onClick={() => handleDetachProject(p.id)}
                                >
                                  Detach
                                </button>
                              </>
                            ) : (
                              <span className="text-xs capitalize text-muted-foreground">{roleLabel(p.grantedRoleLevel)}</span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </TabsContent>

                <TabsContent value="members" className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="flex items-center gap-1.5 font-heading text-base font-medium text-foreground">
                        Members
                        <AppTooltip content={ALL_ROLE_LEVELS.map(roleHelpText).join("\n")} className="max-w-xs">
                          <span
                            className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-md border text-[10px] leading-none text-muted-foreground"
                            aria-label="Access level definitions"
                            tabIndex={0}
                          >
                            ?
                          </span>
                        </AppTooltip>
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
            </>
            )}
          </div>
        </Page>
      }
    />
  )
}

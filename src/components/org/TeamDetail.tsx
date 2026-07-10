import { useCallback, useEffect, useMemo, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { useNavigate, useParams } from "react-router-dom"
import { Check, ChevronDown, FolderGit2, Search, Users } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Page, PageHeader, Section, EmptyState } from "@/components/ui/page"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { AppTooltip } from "@/components/ui/tooltip"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  getTeam,
  addTeamMember,
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

const ROLE_OPTIONS = [
  { level: 100, name: "viewer" },
  { level: 200, name: "commenter" },
  { level: 300, name: "reviewer" },
  { level: 400, name: "contributor" },
  { level: 500, name: "project_lead" },
  { level: 600, name: "maintainer" },
  { level: 700, name: "owner" },
] as const

const editTeamSchema = z.object({
  name: requiredString("Team name"),
  description: optionalString,
})

/**
 * Canonical descriptions for each access level (from AD-6 / permission-semantics.md, AQU-138).
 * Shown as tooltips next to the member's role display.
 */
const ROLE_DESCRIPTIONS: Record<number, string> = {
  100: "Viewer (100) — can read all org projects. No edit or management actions.",
  200: "Commenter (200) — can read and leave comments. Cannot edit content.",
  300: "Reviewer (300) — can read, comment, and review. Cannot make direct edits.",
  400: "Contributor (400) — can edit project content. Maximum level grantable via share link.",
  500: "Project Lead (500) — can add members to projects, mint share-link invites, and lead project work.",
  600: "Maintainer (600) — can create/manage teams, rename the org, set project deadlines, and remove project members.",
  700: "Owner (700) — full control: add/remove org members, archive/restore projects, and all maintainer actions.",
}

function roleLabel(roleLevel: number | null | undefined): string {
  if (roleLevel == null) return "Unknown"
  return ROLE_OPTIONS.find((role) => role.level === roleLevel)?.name ?? `Level ${roleLevel}`
}

function lockedOrgRoleTooltip(roleLevel: number | null | undefined): string {
  const roleDescription = roleLevel != null ? ROLE_DESCRIPTIONS[roleLevel] : null
  const prefix = roleDescription ?? "This member's org-level role is unknown."
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

  // Org members for the add-member picker (admin only)
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([])

  // Org projects for the attach-project picker (admin only)
  const [orgProjects, setOrgProjects] = useState<CloudProjectSummary[]>([])

  // Attach project UI state
  const [attachingProject, setAttachingProject] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState("")
  const [selectedRole, setSelectedRole] = useState(String(ROLE_OPTIONS[0].level))

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

  // Add member UI state
  const [addingMember, setAddingMember] = useState(false)
  const [selectedUsername, setSelectedUsername] = useState("")

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

  useEffect(() => {
    if (!selectedUsername) return
    if (!availableOrgMembers.some((member) => member.username === selectedUsername)) {
      setSelectedUsername("")
    }
  }, [availableOrgMembers, selectedUsername])

  async function handleDelete() {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    setDeleting(true)
    try {
      await deleteTeam(jwt, activeOrgId, groupIdNum)
      navigate("/teams")
    } finally {
      setDeleting(false)
    }
  }

  async function handleAddMember() {
    if (!jwt || activeOrgId == null || groupIdNum == null || !selectedUsername) return
    await addTeamMember(jwt, activeOrgId, groupIdNum, selectedUsername)
    setAddingMember(false)
    setSelectedUsername("")
    await refetch()
  }

  async function handleRemoveMember(userId: number) {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    await removeTeamMember(jwt, activeOrgId, groupIdNum, userId)
    await refetch()
  }

  async function handleAttachProject() {
    if (!jwt || activeOrgId == null || groupIdNum == null || !selectedProjectId) return
    await attachProject(jwt, activeOrgId, groupIdNum, selectedProjectId, Number(selectedRole))
    setAttachingProject(false)
    setSelectedProjectId("")
    setSelectedRole(String(ROLE_OPTIONS[0].level))
    await refetch()
  }

  async function handleChangeProjectRole(projectId: string, roleLevel: number) {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    await changeProjectRole(jwt, activeOrgId, groupIdNum, projectId, roleLevel)
    await refetch()
  }

  async function handleChangeMemberRole(username: string, roleLevel: number) {
    if (!jwt || activeOrgId == null) return
    await addOrgMember(jwt, activeOrgId, username, roleLevel)
    await refetch()
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

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb parent={{ label: "Teams", to: "/teams" }} section={team?.name ?? "Team"} />}
      statusBar={null}
      main={
        <Page size="wide">
          <div className="space-y-6">
            {loading ? (
              <>
                <div className="h-10 w-64 animate-pulse rounded-2xl border bg-card" />
                <div className="h-40 animate-pulse rounded-2xl border bg-card" />
              </>
            ) : team == null ? (
              <EmptyState title="Team not found." description="This team may have been deleted, or you may not have access to it." />
            ) : (
            <>
              {/* Header / rename / delete */}
              <PageHeader
                title={team.name}
                description={team.description || undefined}
                actions={
                  isAdmin ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleEditOpen}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => setConfirmDelete(true)}
                      >
                        Delete team
                      </Button>
                    </>
                  ) : null
                }
              />

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

              {/* Members section */}
              <Section
                title={
                  <span className="flex items-center gap-1.5">
                    Members
                      {/* "?" tooltip summarising all access levels — hover or focus to read */}
                      <AppTooltip content={Object.values(ROLE_DESCRIPTIONS).join("\n")} className="max-w-xs">
                        <span
                          className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border text-[10px] leading-none text-muted-foreground"
                          aria-label="Access level definitions"
                          tabIndex={0}
                        >
                          ?
                        </span>
                      </AppTooltip>
                    </span>
                  }
                  action={
                    isAdmin ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => { setAddingMember(true); setSelectedUsername("") }}
                      >
                        Add member
                      </Button>
                    ) : null
                  }
                >
                  {isAdmin && (
                    <Dialog open={addingMember} onOpenChange={(o) => { if (!o) { setAddingMember(false); setSelectedUsername("") } }}>
                      <DialogContent className="max-w-md">
                        <DialogHeader>
                          <DialogTitle>Add member to &apos;{team.name}&apos;</DialogTitle>
                        </DialogHeader>
                        <TeamMemberCombobox
                          members={availableOrgMembers}
                          value={selectedUsername}
                          onChange={setSelectedUsername}
                          disabled={availableOrgMembers.length === 0}
                        />
                        {availableOrgMembers.length === 0 && (
                          <p className="text-xs text-muted-foreground">
                            All org members are already in this team.
                          </p>
                        )}
                        <DialogFooter>
                          <Button type="button" variant="outline" onClick={() => { setAddingMember(false); setSelectedUsername("") }}>
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            onClick={handleAddMember}
                            disabled={!selectedUsername || availableOrgMembers.length === 0}
                          >
                            Add
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}

                  {team.members.length === 0 ? (
                    <EmptyState
                      icon={Users}
                      title="No members."
                      description={isAdmin ? "Add org members to this team to grant them shared project access." : undefined}
                    />
                  ) : (
                    <ul className="space-y-2">
                      {team.members.map((m) => (
                        <li key={m.userId} className="flex items-center justify-between rounded-2xl border px-4 py-2 text-sm">
                          <span className="font-medium">{m.username}</span>
                          <div className="flex items-center gap-2">
                            {isOwner ? (
                              /* Owners can change the member's org-level role via the upsert endpoint */
                              <Select
                                items={ROLE_OPTIONS.map((r) => ({ value: String(r.level), label: r.name }))}
                                value={m.roleLevel != null ? String(m.roleLevel) : ""}
                                onValueChange={(v) => { if (v) void handleChangeMemberRole(m.username, Number(v)) }}
                              >
                                <SelectTrigger
                                  size="sm"
                                  className="text-xs"
                                  aria-label={`Role for ${m.username}`}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    {ROLE_OPTIONS.map((r) => (
                                      <SelectItem key={r.level} value={String(r.level)}>
                                        {r.name}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            ) : (
                              /* Non-owners see the org-level role but cannot edit it here. */
                              <AppTooltip content={lockedOrgRoleTooltip(m.roleLevel)} className="max-w-xs">
                                <span
                                  tabIndex={0}
                                  className="inline-flex cursor-help items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
                                  aria-label={`Org-level role: ${roleLabel(m.roleLevel)}`}
                                >
                                  {roleLabel(m.roleLevel)}
                                  <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border text-[10px] leading-none text-muted-foreground" aria-hidden="true">?</span>
                                </span>
                              </AppTooltip>
                            )}
                            {isAdmin && (
                              <button
                                type="button"
                                className="text-xs text-destructive underline"
                                aria-label={`Remove ${m.username}`}
                                onClick={() => handleRemoveMember(m.userId)}
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
            </>
            )}

            {/* Projects section — always rendered when authenticated; management controls admin-only.
                The heading is deferred until team loads to avoid multiple /projects/i DOM matches
                (sidebar nav also has "Projects") that would cause getByText to throw in tests. */}
            {jwt != null && (
                  <Section
                    title={!loading ? "Projects" : undefined}
                    action={
                      isAdmin && !attachingProject ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const teamProjects = team?.projects ?? []
                            const attachableProjects = orgProjects.filter(
                              (op) => !teamProjects.some((tp) => tp.id === op.id),
                            )
                            setSelectedProjectId(attachableProjects[0]?.id ?? "")
                            setSelectedRole(String(ROLE_OPTIONS[0].level))
                            setAttachingProject(true)
                          }}
                        >
                          Attach project
                        </Button>
                      ) : null
                    }
                  >
                    {isAdmin && attachingProject && (
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <Select
                          items={orgProjects
                            .filter((op) => !(team?.projects ?? []).some((tp) => tp.id === op.id))
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
                                .filter((op) => !(team?.projects ?? []).some((tp) => tp.id === op.id))
                                .map((op) => (
                                  <SelectItem key={op.id} value={op.id}>{op.name}</SelectItem>
                                ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        <Select
                          items={ROLE_OPTIONS.map((r) => ({ value: String(r.level), label: r.name }))}
                          value={selectedRole}
                          onValueChange={(v) => setSelectedRole(v ?? "")}
                        >
                          <SelectTrigger aria-label="Granted role">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {ROLE_OPTIONS.map((r) => (
                                <SelectItem key={r.level} value={String(r.level)}>{r.name}</SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        <Button type="button" size="sm" onClick={handleAttachProject}>Attach</Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => { setAttachingProject(false); setSelectedProjectId("") }}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}

                    {(team?.projects ?? []).length === 0 && !loading ? (
                      <EmptyState
                        icon={FolderGit2}
                        title="No projects."
                        description={isAdmin ? "Attach a project to grant this team access at a chosen role." : undefined}
                      />
                    ) : (
                      <ul className="space-y-2">
                        {(team?.projects ?? []).map((p) => (
                          <li key={p.id} className="flex items-center justify-between rounded-2xl border px-4 py-2 text-sm">
                            <button
                              type="button"
                              className="text-left font-medium hover:underline"
                              onClick={() => navigate(`/projects/${p.id}`)}
                            >
                              {p.name}
                            </button>
                            <div className="flex items-center gap-2">
                              {isAdmin ? (
                                <>
                                  <Select
                                    items={ROLE_OPTIONS.map((r) => ({ value: String(r.level), label: r.name }))}
                                    value={String(p.grantedRoleLevel)}
                                    onValueChange={(v) => { if (v) void handleChangeProjectRole(p.id, Number(v)) }}
                                  >
                                    <SelectTrigger size="sm" className="text-xs" aria-label={`Role for ${p.name}`}>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectGroup>
                                        {ROLE_OPTIONS.map((r) => (
                                          <SelectItem key={r.level} value={String(r.level)}>{r.name}</SelectItem>
                                        ))}
                                      </SelectGroup>
                                    </SelectContent>
                                  </Select>
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
                                <span className="text-xs tabular-nums text-muted-foreground">Level {p.grantedRoleLevel}</span>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
              </Section>
            )}
          </div>
        </Page>
      }
    />
  )
}

function TeamMemberCombobox({
  members,
  value,
  onChange,
  disabled,
}: {
  members: OrgMember[]
  value: string
  onChange: (username: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const selectedMember = members.find((member) => member.username === value)
  const filteredMembers = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return members
    return members.filter((member) =>
      member.username.toLocaleLowerCase().includes(normalizedQuery)
    )
  }, [members, query])

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) setQuery("")
  }

  function handlePick(username: string) {
    onChange(username)
    setOpen(false)
    setQuery("")
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            role="combobox"
            aria-label="Member to add"
            aria-expanded={open}
            aria-controls="team-member-combobox-list"
            disabled={disabled}
            className="inline-flex h-8 min-w-64 items-center justify-between gap-2 rounded-lg border border-input bg-background px-2.5 text-left text-sm outline-none transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        }
      >
        <span className={selectedMember ? "truncate" : "truncate text-muted-foreground"}>
          {selectedMember?.username ?? "Search members..."}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" side="bottom" sideOffset={4}>
        <InputGroup className="mb-2">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search org members..."
            aria-label="Search org members"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
          />
        </InputGroup>
        <div
          id="team-member-combobox-list"
          role="listbox"
          aria-label="Org members"
          className="max-h-56 overflow-y-auto rounded-md border bg-background p-1"
        >
          {filteredMembers.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No available members match.
            </p>
          ) : (
            filteredMembers.map((member) => {
              const isSelected = member.username === value
              return (
                <button
                  key={member.userId}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
                    isSelected ? "bg-muted/60" : ""
                  }`}
                  onClick={() => handlePick(member.username)}
                >
                  <span className="truncate">{member.username}</span>
                  {isSelected && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  )}
                </button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

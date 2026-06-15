import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { Check, ChevronDown, Search } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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

/**
 * Canonical descriptions for each access level (from AD-6 / permission-semantics.md, FRO-138).
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
  const [editName, setEditName] = useState("")
  const [editDescription, setEditDescription] = useState("")

  // Delete confirm state
  const [confirmDelete, setConfirmDelete] = useState(false)

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

  async function handleSave() {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    // Defensive: only include description in the PATCH payload if the server already
    // returned one (team.description !== undefined) OR the user explicitly typed a
    // non-empty value. This prevents a name-only rename silently wiping the description
    // on older server builds that don't yet return description in the detail payload.
    const patch: { name: string; description?: string } = { name: editName }
    if (team?.description !== undefined || editDescription !== "") {
      patch.description = editDescription
    }
    await updateTeam(jwt, activeOrgId, groupIdNum, patch)
    setEditing(false)
    await refetch()
  }

  async function handleDelete() {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    await deleteTeam(jwt, activeOrgId, groupIdNum)
    navigate("/teams")
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

  function handleEditOpen() {
    setEditName(team?.name ?? "")
    setEditDescription(team?.description ?? "")
    setEditing(true)
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={team?.name ?? "Team"} />}
      statusBar={null}
      main={
        <div className="h-full overflow-y-auto p-6 space-y-8">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : team == null ? (
            <p className="text-sm text-muted-foreground">Team not found.</p>
          ) : (
            <>
              {/* Header / rename / delete */}
              <section>
                <div className="flex items-center gap-3 mb-3">
                  <h1 className="text-lg font-semibold">{team.name}</h1>
                  {isAdmin && !editing && (
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
                  )}
                </div>
                {!editing && team.description && (
                  <p className="mb-3 text-sm text-muted-foreground">{team.description}</p>
                )}

                {isAdmin && editing && (
                  <div className="space-y-2">
                    <input
                      className="border rounded px-2 py-1 text-sm w-full"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Team name"
                    />
                    <input
                      className="border rounded px-2 py-1 text-sm w-full"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      placeholder="Description (optional)"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="text-sm px-3 py-1 rounded bg-primary text-primary-foreground"
                        onClick={handleSave}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="text-sm px-3 py-1 rounded border"
                        onClick={() => setEditing(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {isAdmin && confirmDelete && (
                  <div className="mt-2 rounded border border-destructive p-3 space-y-2 text-sm">
                    <p>Delete &apos;{team.name}&apos;? This removes the team and all its grants.</p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="px-3 py-1 rounded bg-destructive text-destructive-foreground"
                        onClick={handleDelete}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        className="px-3 py-1 rounded border"
                        onClick={() => setConfirmDelete(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </section>

              {/* Members section */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1.5">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Members</h2>
                    {/* "?" tooltip summarising all access levels — hover or focus to read */}
                    <AppTooltip content={Object.values(ROLE_DESCRIPTIONS).join("\n")} className="max-w-xs">
                      <span
                        className="inline-flex items-center justify-center rounded-full border w-4 h-4 text-[10px] leading-none text-muted-foreground cursor-help"
                        aria-label="Access level definitions"
                        tabIndex={0}
                      >
                        ?
                      </span>
                    </AppTooltip>
                  </div>
                  {isAdmin && !addingMember && (
                    <button
                      type="button"
                      className="text-xs underline text-muted-foreground"
                      onClick={() => { setAddingMember(true); setSelectedUsername("") }}
                    >
                      Add member
                    </button>
                  )}
                </div>

                {isAdmin && addingMember && (
                  <div className="flex flex-wrap items-center gap-2 mb-3">
                    <TeamMemberCombobox
                      members={availableOrgMembers}
                      value={selectedUsername}
                      onChange={setSelectedUsername}
                      disabled={availableOrgMembers.length === 0}
                    />
                    <button
                      type="button"
                      className="text-sm px-3 py-1 rounded bg-primary text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={handleAddMember}
                      disabled={!selectedUsername || availableOrgMembers.length === 0}
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      className="text-sm px-3 py-1 rounded border"
                      onClick={() => { setAddingMember(false); setSelectedUsername("") }}
                    >
                      Cancel
                    </button>
                    {availableOrgMembers.length === 0 && (
                      <p className="basis-full text-xs text-muted-foreground">
                        All org members are already in this team.
                      </p>
                    )}
                  </div>
                )}

                {team.members.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No members.</p>
                ) : (
                  <ul className="space-y-2">
                    {team.members.map((m) => (
                      <li key={m.userId} className="flex items-center justify-between rounded-lg border px-4 py-2 text-sm">
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
                                title={m.roleLevel != null ? ROLE_DESCRIPTIONS[m.roleLevel] : "Unknown role"}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  {ROLE_OPTIONS.map((r) => (
                                    <SelectItem key={r.level} value={String(r.level)} title={ROLE_DESCRIPTIONS[r.level]}>
                                      {r.name}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          ) : (
                            /* Non-owners see a read-only label with a tooltip explaining the role */
                            <AppTooltip content={m.roleLevel != null ? ROLE_DESCRIPTIONS[m.roleLevel] : "Unknown role"} className="max-w-xs">
                              <span
                                className="text-xs text-muted-foreground cursor-help"
                                aria-label={m.roleLevel != null ? `Role: ${ROLE_OPTIONS.find((r) => r.level === m.roleLevel)?.name ?? `level ${m.roleLevel}`}` : "Role unknown"}
                              >
                                {m.roleLevel != null
                                  ? (ROLE_OPTIONS.find((r) => r.level === m.roleLevel)?.name ?? `Level ${m.roleLevel}`)
                                  : "—"}
                                {" "}
                                <span className="inline-flex items-center justify-center rounded-full border w-3.5 h-3.5 text-[10px] leading-none text-muted-foreground" aria-hidden="true">?</span>
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
              </section>

            </>
          )}

          {/* Projects section — always rendered when authenticated; management controls admin-only.
              The heading is deferred until team loads to avoid multiple /projects/i DOM matches
              (sidebar nav also has "Projects") that would cause getByText to throw in tests. */}
          {jwt != null && (
            <section>
              <div className="flex items-center justify-between mb-3">
                {!loading && <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Projects</h2>}
                {isAdmin && !attachingProject && (
                  <button
                    type="button"
                    className="text-xs underline text-muted-foreground"
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
                  </button>
                )}
              </div>

              {isAdmin && attachingProject && (
                <div className="flex items-center gap-2 mb-3">
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
                  <button
                    type="button"
                    className="text-sm px-3 py-1 rounded bg-primary text-primary-foreground"
                    onClick={handleAttachProject}
                  >
                    Attach
                  </button>
                  <button
                    type="button"
                    className="text-sm px-3 py-1 rounded border"
                    onClick={() => { setAttachingProject(false); setSelectedProjectId("") }}
                  >
                    Cancel
                  </button>
                </div>
              )}

              {(team?.projects ?? []).length === 0 && !loading ? (
                <p className="text-sm text-muted-foreground">No projects.</p>
              ) : (
                <ul className="space-y-2">
                  {(team?.projects ?? []).map((p) => (
                    <li key={p.id} className="flex items-center justify-between rounded-lg border px-4 py-2 text-sm">
                      <button
                        type="button"
                        className="font-medium text-left hover:underline"
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
                          <span className="text-xs text-muted-foreground">Level {p.grantedRoleLevel}</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
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
        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search org members..."
            aria-label="Search org members"
            className="pl-8"
            autoFocus
          />
        </div>
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

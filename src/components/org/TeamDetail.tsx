import { useCallback, useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
import { Button } from "@/components/ui/button"
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

  // All org members available to add (server handles duplicate-membership rejection)
  const availableOrgMembers = orgMembers

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
                    <span
                      className="inline-flex items-center justify-center rounded-full border w-4 h-4 text-[10px] leading-none text-muted-foreground cursor-help"
                      title={Object.values(ROLE_DESCRIPTIONS).join("\n")}
                      aria-label="Access level definitions"
                      tabIndex={0}
                    >
                      ?
                    </span>
                  </div>
                  {isAdmin && !addingMember && (
                    <button
                      type="button"
                      className="text-xs underline text-muted-foreground"
                      onClick={() => { setAddingMember(true); setSelectedUsername(availableOrgMembers[0]?.username ?? "") }}
                    >
                      Add member
                    </button>
                  )}
                </div>

                {isAdmin && addingMember && (
                  <div className="flex items-center gap-2 mb-3">
                    <Select
                      value={selectedUsername}
                      onValueChange={(v) => setSelectedUsername(v ?? "")}
                    >
                      <SelectTrigger aria-label="Member to add">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {availableOrgMembers.map((m) => (
                            <SelectItem key={m.userId} value={m.username}>{m.username}</SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <button
                      type="button"
                      className="text-sm px-3 py-1 rounded bg-primary text-primary-foreground"
                      onClick={handleAddMember}
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
                            <span
                              className="text-xs text-muted-foreground cursor-help"
                              title={m.roleLevel != null ? ROLE_DESCRIPTIONS[m.roleLevel] : "Unknown role"}
                              aria-label={m.roleLevel != null ? `Role: ${ROLE_OPTIONS.find((r) => r.level === m.roleLevel)?.name ?? `level ${m.roleLevel}`}` : "Role unknown"}
                            >
                              {m.roleLevel != null
                                ? (ROLE_OPTIONS.find((r) => r.level === m.roleLevel)?.name ?? `Level ${m.roleLevel}`)
                                : "—"}
                              {" "}
                              <span className="inline-flex items-center justify-center rounded-full border w-3.5 h-3.5 text-[10px] leading-none text-muted-foreground" aria-hidden="true">?</span>
                            </span>
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

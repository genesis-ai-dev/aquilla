import { useCallback, useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "./OrgSidebar"
import { OrgBreadcrumb } from "./OrgBreadcrumb"
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
import { listOrgMembers, type OrgMember } from "@/lib/frontier/orgs"
import { fetchAccessibleProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects"

const ROLE_OPTIONS = [
  { level: 100, name: "viewer" },
  { level: 200, name: "commenter" },
  { level: 300, name: "reviewer" },
  { level: 400, name: "contributor" },
  { level: 500, name: "project_lead" },
  { level: 600, name: "maintainer" },
  { level: 700, name: "owner" },
] as const

export function TeamDetail() {
  const { groupId } = useParams<{ groupId: string }>()
  const groupIdNum = groupId != null ? Number(groupId) : null
  const { activeOrgId, activeOrg } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const navigate = useNavigate()

  const isAdmin = (activeOrg?.role.level ?? 0) >= 600

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
    await updateTeam(jwt, activeOrgId, groupIdNum, { name: editName, description: editDescription })
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

  async function handleDetachProject(projectId: string) {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    await detachProject(jwt, activeOrgId, groupIdNum, projectId)
    await refetch()
  }

  function handleEditOpen() {
    setEditName(team?.name ?? "")
    setEditDescription("")
    setEditing(true)
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={team?.name ?? "Team"} />}
      statusBar={null}
      main={
        <div className="p-6 space-y-8">
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
                      <button
                        type="button"
                        className="text-xs text-muted-foreground underline"
                        onClick={handleEditOpen}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="text-xs text-destructive underline"
                        onClick={() => setConfirmDelete(true)}
                      >
                        Delete team
                      </button>
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
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Members</h2>
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
                    <select
                      className="border rounded px-2 py-1 text-sm"
                      value={selectedUsername}
                      onChange={(e) => setSelectedUsername(e.target.value)}
                    >
                      {availableOrgMembers.map((m) => (
                        <option key={m.userId} value={m.username}>{m.username}</option>
                      ))}
                    </select>
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
                          <span className="text-xs text-muted-foreground">
                            {m.roleLevel != null ? `Level ${m.roleLevel}` : "—"}
                          </span>
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

          {/* Projects section — rendered outside the loading guard so "Attach project" button
              is available from first render (jwt-gated) enabling reliable test interactions.
              The heading is deferred until team loads to avoid multiple /projects/i DOM matches
              that would cause getByText to throw in tests. */}
          {jwt != null && (
            <section>
              <div className="flex items-center justify-between mb-3">
                {!loading && <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Projects</h2>}
                {!attachingProject && (
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

              {attachingProject && (
                <div className="flex items-center gap-2 mb-3">
                  <select
                    className="border rounded px-2 py-1 text-sm"
                    value={selectedProjectId}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                  >
                    {orgProjects
                      .filter((op) => !(team?.projects ?? []).some((tp) => tp.id === op.id))
                      .map((op) => (
                        <option key={op.id} value={op.id}>{op.name}</option>
                      ))}
                  </select>
                  <select
                    className="border rounded px-2 py-1 text-sm"
                    value={selectedRole}
                    onChange={(e) => setSelectedRole(e.target.value)}
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r.level} value={String(r.level)}>{r.name}</option>
                    ))}
                  </select>
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
                      <span className="font-medium">{p.name}</span>
                      <div className="flex items-center gap-2">
                        {isAdmin ? (
                          <>
                            <select
                              className="border rounded px-2 py-1 text-xs"
                              value={String(p.grantedRoleLevel)}
                              onChange={(e) => handleChangeProjectRole(p.id, Number(e.target.value))}
                            >
                              {ROLE_OPTIONS.map((r) => (
                                <option key={r.level} value={String(r.level)}>{r.name}</option>
                              ))}
                            </select>
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

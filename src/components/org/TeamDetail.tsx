import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { Link, useNavigate, useParams } from "react-router-dom"
import { AlertTriangle, FolderGit2, Settings, ShieldUser, Unlink, UserMinus, Users } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { MemberMultiSelect } from "@/components/MemberMultiSelect"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { TeamLaneChecks } from "./TeamLaneChecks"
import { TeamRoleSelect } from "./TeamRoleSelect"
import { useCurrentTargetLanes } from "@/hooks/useCurrentTargetLanes"
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
import { ScopeBreadcrumb } from "@/components/access/ScopeBreadcrumb"
import { EffectiveRoleCell } from "@/components/access/EffectiveRoleCell"
import { GrantOriginBadge } from "@/components/access/GrantOriginBadge"
import { InheritedRoleControl } from "@/components/access/InheritedRoleControl"
import { formatScopePath } from "@/lib/access/scope-path"
import type { GrantOrigin, ScopePath } from "@/lib/access/types"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Field, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { GrantScopeNotice } from "@/components/GrantScopeNotice"
import { MenuItem, MenuSeparator } from "@/components/ui/menu-parts"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { Page, EmptyState, NotFoundIcon, TableEmptyState } from "@/components/ui/page"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DisabledFieldTooltip } from "@/components/ProjectSettings/DisabledFieldTooltip"
import { NoteOnClick } from "@/components/ui/info-note"
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
  setTeamMemberRole,
  setTeamProjectLanes,
  type TeamDetail as TeamDetailType,
} from "@/lib/frontier/teams"
import { listOrgMembers, addOrgMember, type OrgMember } from "@/lib/frontier/orgs"
import type { MemberGrantResult } from "@/lib/frontier/members"
import {
  fetchAccessibleProjectsResult,
  projectsResultError,
  type CloudProjectSummary,
} from "@/lib/sync/cloud-projects"
import { SearchSelect } from "@/components/ui/search-select"
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
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"
import { toUserFacingError, UserError } from "@/lib/errors/user-error"
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
  const { t, locale } = useI18n()
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
  // AQU-1352 P2: org maintainer+, or a team maintainer on this team, may set
  // team roles, capped at their own level (server enforces the same gate).
  const myTeamRole = team?.members.find((m) => m.username === session?.username)?.teamRoleLevel ?? 0
  const teamRoleCap = Math.max(activeOrg?.role.level ?? 0, myTeamRole)
  const canEditTeamRoles = teamRoleCap >= 600
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const teamRequestRef = useRef(0)
  const teamScopeKey = jwt && activeOrgId != null && groupIdNum != null
    ? `${jwt}\u0000${activeOrgId}\u0000${groupIdNum}`
    : null
  const teamScopeRef = useRef(teamScopeKey)
  teamScopeRef.current = teamScopeKey
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
  const [attachLaneIds, setAttachLaneIds] = useState<string[]>([])
  const [attachLaneProject, setAttachLaneProject] = useState("")
  const { lanes: attachLanes, ready: attachLanesReady } = useCurrentTargetLanes(
    attachingProject && selectedProjectId ? selectedProjectId : null,
  )

  // Add member UI state — multi-select (AQU-735): stage several org members via
  // MemberMultiSelect (same checkbox combobox as named validators) and grant
  // them all in one batch request.
  const [addingMember, setAddingMember] = useState(false)
  const [stagedUsernames, setStagedUsernames] = useState<string[]>([])
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  // AQU-2238: the outside-the-org path. The picker can only ever offer people
  // already on the org roster, so staffing a team with someone external used to
  // mean org add → team add → org remove. This free-text username/email goes
  // straight to the team as a guest, leaving the org roster untouched.
  const [externalIdentifier, setExternalIdentifier] = useState("")

  // Change-role dialog (owners only) — opened from the row actions menu.
  const [roleChangeTarget, setRoleChangeTarget] = useState<TeamMember | null>(null)
  const [roleChangeLevel, setRoleChangeLevel] = useState("")
  const [roleChangeBusy, setRoleChangeBusy] = useState(false)

  // Change team-grant role on an attached project — opened from the projects row menu.
  const [projectRoleTarget, setProjectRoleTarget] = useState<TeamProject | null>(null)
  const [projectRoleLevel, setProjectRoleLevel] = useState("")
  const [projectRoleBusy, setProjectRoleBusy] = useState(false)

  const [laneEditTarget, setLaneEditTarget] = useState<TeamProject | null>(null)
  const [laneEditIds, setLaneEditIds] = useState<string[]>([])
  const [laneEditReadyFor, setLaneEditReadyFor] = useState<string | null>(null)
  const [laneEditBusy, setLaneEditBusy] = useState(false)
  const { lanes: editLanes, ready: editLanesReady } = useCurrentTargetLanes(laneEditTarget?.id ?? null)

  useEffect(() => {
    if (!attachingProject || !attachLanesReady || !selectedProjectId) return
    if (attachLaneProject === selectedProjectId) return
    setAttachLaneProject(selectedProjectId)
    setAttachLaneIds(attachLanes.map((lane) => lane.id))
  }, [attachingProject, attachLanesReady, selectedProjectId, attachLanes, attachLaneProject])

  useEffect(() => {
    if (!laneEditTarget || !editLanesReady) return
    if (laneEditReadyFor === laneEditTarget.id) return
    setLaneEditReadyFor(laneEditTarget.id)
    if (laneEditTarget.lanesExplicit) {
      const allowed = new Set(editLanes.map((lane) => lane.id))
      setLaneEditIds((laneEditTarget.laneIds ?? []).filter((id) => allowed.has(id)))
    } else {
      setLaneEditIds(editLanes.map((lane) => lane.id))
    }
  }, [laneEditTarget, editLanesReady, editLanes, laneEditReadyFor])

  const refetch = useCallback(async () => {
    const request = ++teamRequestRef.current
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    setLoading(true)
    setLoadError(null)
    try {
      const t = await getTeam(jwt, activeOrgId, groupIdNum)
      if (teamRequestRef.current !== request || teamScopeRef.current !== teamScopeKey) return
      setTeam(t)
    } catch (error) {
      if (teamRequestRef.current !== request || teamScopeRef.current !== teamScopeKey) return
      if (error instanceof UserError && error.category === "session-expired") {
        void notifySessionExpiredIfCurrent(jwt)
      }
      const userFacing = toUserFacingError(error, "team")
      setTeam(null)
      setLoadError(
        userFacing.category === "not-found" || userFacing.category === "forbidden"
          ? null
          : userFacing.message,
      )
    } finally {
      if (teamRequestRef.current === request && teamScopeRef.current === teamScopeKey) setLoading(false)
    }
  }, [jwt, activeOrgId, groupIdNum, teamScopeKey])

  useEffect(() => {
    void refetch()
  }, [refetch])

  // Load org members once for admin pickers
  useEffect(() => {
    if (!isAdmin || !jwt || activeOrgId == null) return
    let cancelled = false
    listOrgMembers(jwt, activeOrgId).then((members) => {
      if (!cancelled && teamScopeRef.current === teamScopeKey) setOrgMembers(members)
    }).catch((error) => {
      if (cancelled || teamScopeRef.current !== teamScopeKey) return
      if (error instanceof UserError && error.category === "session-expired") {
        void notifySessionExpiredIfCurrent(jwt)
      }
      setOrgMembers([])
      setAddError(toUserFacingError(error, "organization members").message)
    })
    return () => { cancelled = true }
  }, [isAdmin, jwt, activeOrgId, teamScopeKey])

  // Load org projects once for admin attach picker
  useEffect(() => {
    if (!isAdmin || !jwt || activeOrgId == null) return
    let cancelled = false
    void fetchAccessibleProjectsResult(jwt, activeOrgId).then((result) => {
      if (cancelled || teamScopeRef.current !== teamScopeKey) return
      if (!result.ok) {
        if (result.reason === "unauthenticated") void notifySessionExpiredIfCurrent(jwt)
        throw projectsResultError(result)
      }
      setOrgProjects(result.projects)
    }).catch((error) => {
      if (!cancelled && teamScopeRef.current === teamScopeKey) {
        setAddError(error instanceof Error ? error.message : String(error))
      }
    })
    return () => { cancelled = true }
  }, [isAdmin, jwt, activeOrgId, teamScopeKey])

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

  // AQU-2238 / AQU-1030: a guest's reach is exactly this team's attached
  // projects — nothing org-wide, and no org-roster entry. An unattached team
  // grants nothing yet, and saying so beats an invite that looks like it worked
  // and shows the person an empty workspace.
  const externalGrantSentence = useMemo(() => {
    const names = (team?.projects ?? []).map((project) => project.name)
    return names.length === 0
      ? t("org.teamDetail.outsideOrgScopeNoProjects")
      : t("org.teamDetail.outsideOrgScopeWithProjects", {
          projects: new Intl.ListFormat(locale, { type: "conjunction", style: "long" }).format(names),
        })
  }, [team?.projects, t, locale])

  function closeAddMember() {
    setAddingMember(false)
    setStagedUsernames([])
    setExternalIdentifier("")
    setAddError(null)
  }

  async function handleAddMembers() {
    if (!jwt || activeOrgId == null || groupIdNum == null) return
    const external = externalIdentifier.trim()
    if (stagedUsernames.length === 0 && !external) return
    setAddBusy(true)
    setAddError(null)
    try {
      // ONE batch request per path — the endpoint is non-atomic and returns
      // per-person results in request order, so one rejected person never
      // sinks the rest. The outside-the-org invite is its own request because
      // `external` waives the org-roster requirement for the WHOLE request
      // (AQU-2238), and the picker path must keep failing closed: someone who
      // silently lost their org membership should still be rejected there.
      const results: MemberGrantResult[] = []
      if (stagedUsernames.length > 0) {
        results.push(...(await addTeamMembers(jwt, activeOrgId, groupIdNum, stagedUsernames)))
      }
      if (external) {
        results.push(
          ...(await addTeamMembers(jwt, activeOrgId, groupIdNum, [external], { external: true })),
        )
      }
      await refetch()
      const failures = results.filter((r) => !r.ok)
      if (failures.length === 0) {
        closeAddMember()
        return
      }
      // Keep only the people who failed staged for a retry; drop the successes.
      // Name each failure with its reason — no silent all-or-nothing. The
      // external identifier is kept in its own field, never folded into the
      // org-member picker (it is not an org member — that is the point).
      const failed = new Set(failures.map((f) => f.username))
      setStagedUsernames(stagedUsernames.filter((username) => failed.has(username)))
      setExternalIdentifier(external && failed.has(external) ? external : "")
      setAddError(
        failures
          .map((f) => `${f.username} (${f.error?.message ?? t("org.teamDetail.couldntBeAddedFallback")})`)
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
    setAttachLaneIds([])
    setAttachLaneProject("")
  }

  function openAttachProject() {
    setSelectedProjectId(attachableProjects[0]?.id ?? "")
    setSelectedRole(ROLE.VIEWER)
    setAttachingProject(true)
  }

  async function handleAttachProject() {
    if (!jwt || activeOrgId == null || groupIdNum == null || !selectedProjectId) return
    if (attachLanes.length > 0 && attachLaneIds.length === 0) return
    const laneIds = attachLanes.length > 0 ? attachLaneIds : undefined
    await attachProject(jwt, activeOrgId, groupIdNum, selectedProjectId, selectedRole, laneIds)
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

  function openLaneEdit(project: TeamProject) {
    setLaneEditTarget(project)
    setLaneEditReadyFor(null)
    setLaneEditIds([])
  }

  function closeLaneEdit() {
    setLaneEditTarget(null)
    setLaneEditIds([])
    setLaneEditReadyFor(null)
    setLaneEditBusy(false)
  }

  async function confirmLaneEdit() {
    if (!jwt || activeOrgId == null || groupIdNum == null || !laneEditTarget) return
    if (editLanes.length > 0 && laneEditIds.length === 0) return
    setLaneEditBusy(true)
    try {
      await setTeamProjectLanes(jwt, activeOrgId, groupIdNum, laneEditTarget.id, laneEditIds)
      closeLaneEdit()
      await refetch()
    } finally {
      setLaneEditBusy(false)
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
          <UsernameWithAvatar userId={row.original.userId} username={row.original.username} size="xs" nameClassName="font-normal" />
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
          // AQU-2238: no org_members row is the normal state for a guest added
          // straight to this team, so name it instead of reporting "Unknown".
          if (m.roleLevel == null) {
            return (
              <AppTooltip content={t("org.teamDetail.outsideOrgRoleTooltip")} className="max-w-xs">
                <span tabIndex={0} className="inline-flex cursor-help text-sm text-muted-foreground">
                  {t("org.teamDetail.outsideOrgRole")}
                </span>
              </AppTooltip>
            )
          }

          const label = <RoleLabel name={m.roleLevel} />

          // Owners change roles via the actions menu dialog — badge is display-only.
          // Non-owners get a note explaining the org-level lock, opened by a
          // click on the role (AQU-2260: never a hover).
          if (isOwner) return label

          return (
            <NoteOnClick
              note={lockedOrgRoleTooltip(m.roleLevel)}
              label={t("org.teamDetail.orgLevelRoleAriaLabel", { role: roleLabel(m.roleLevel) })}
            >
              {label}
            </NoteOnClick>
          )
        },
      },
      {
        id: "teamRole",
        accessorFn: (m) => m.teamRoleLevel ?? 0,
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.teamDetail.teamRoleColumn")} />,
        meta: { className: "w-[16rem] whitespace-nowrap" },
        cell: ({ row }) => {
          const m = row.original
          const current = m.teamRoleLevel ?? null
          const canEditRow = canEditTeamRoles && (current ?? 0) <= teamRoleCap
          // AQU-1352 §3.7 rule 1: a NULL team role inherits the org role; a set
          // one is a direct grant at this team. The effective role is the higher.
          // AQU-2238: a guest has no org role to inherit, so never offer the
          // org as the source of their team role — the team's project grants
          // are the whole of their access.
          const orgRef = activeOrgId != null && activeOrg?.name && m.roleLevel != null
            ? { type: "org" as const, id: String(activeOrgId), name: activeOrg.name }
            : null
          const origin: GrantOrigin = current == null
            ? { kind: "inherited", from: orgRef ? [orgRef] : undefined }
            : { kind: "direct" }
          const orgLevel = m.roleLevel ?? null
          const effective = current == null ? orgLevel : Math.max(current, orgLevel ?? 0)
          const effectiveOrigin: GrantOrigin = current != null && current >= (orgLevel ?? 0)
            ? { kind: "direct" }
            : { kind: "inherited", from: orgRef ? [orgRef] : undefined }
          const select = (
            <TeamRoleSelect
              username={m.username}
              value={current}
              canEdit={canEditRow}
              maxLevel={teamRoleCap}
              onChange={async (level) => {
                if (!jwt || activeOrgId == null || groupIdNum == null) return
                try {
                  await setTeamMemberRole(jwt, activeOrgId, groupIdNum, m.userId, level)
                  await refetch()
                } catch (error) {
                  toast.add({
                    type: "error",
                    title: t("org.teamDetail.teamRoleUpdateFailed"),
                    description: toUserFacingError(error, "team").message,
                  })
                }
              }}
            />
          )
          return (
            <span className="inline-flex items-center gap-2">
              <GrantOriginBadge origin={origin} />
              {/* Editors keep the select: choosing a team role is how a direct
                  team grant is created. Read-only viewers get "Set at <org>". */}
              {canEditRow ? select : (
                <InheritedRoleControl origin={origin} hrefFor={(scope) => (scope.type === "org" ? `/orgs/${scope.id}/members` : undefined)}>
                  {select}
                </InheritedRoleControl>
              )}
              {/* Only when the org role outranks the team role; otherwise the
                  Role column / select already say it. */}
              {current != null && effective !== current && (
                <EffectiveRoleCell
                  className="text-xs text-muted-foreground"
                  directRoleLevel={current}
                  effectiveRoleLevel={effective}
                  effectiveOrigin={effectiveOrigin}
                />
              )}
            </span>
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
    [isOwner, t, canEditTeamRoles, teamRoleCap, jwt, activeOrgId, activeOrg?.name, groupIdNum, refetch],
  )

  const teamDescription = team?.description?.trim() || null
  // AQU-2140: the team page is the overview. The control links there (the same
  // path row-click and create already use) and reveals members plus projects.
  const teamOverviewHref =
    activeOrgId != null && groupIdNum != null
      ? orgPath(activeOrgId, `/teams/${groupIdNum}`)
      : null
  const teamScopePath: ScopePath = [
    ...(activeOrgId != null && activeOrg?.name ? [{ type: "org" as const, id: String(activeOrgId), name: activeOrg.name }] : []),
    ...(team ? [{ type: "team" as const, id: String(team.id), name: team.name }] : []),
  ]

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb parent={{ label: "Teams", to: activeOrgId != null ? orgPath(activeOrgId, "/teams") : "/orgs/all" }} section={team?.name ?? "Team"} />}
      statusBar={null}
      main={
        <Page size="full" className="@container/team-detail">
          {/* Below the max-w-6xl column: same well as other org pages, logo
              inline with the title, no extra body indent. At/above that width
              (@6xl = 72rem container): well grows by the avatar gutter so the
              title stays on the shared column, and tabs/tables pad to it. */}
          <div
            data-testid="team-detail-well"
            className="mx-auto w-full max-w-6xl space-y-6 @6xl/team-detail:ml-[max(0px,calc((100%-72rem)/2-2.75rem))] @6xl/team-detail:w-[min(100%,calc(72rem+2.75rem))] @6xl/team-detail:max-w-[calc(72rem+2.75rem)]"
          >
            {loading ? (
              <>
                <div className="h-10 w-64 animate-pulse rounded-lg border bg-card" />
                <div className="h-8 w-72 animate-pulse rounded-lg border bg-card" />
                <div className="h-40 animate-pulse rounded-lg border bg-card" />
              </>
            ) : loadError ? (
              <EmptyState
                icon={AlertTriangle}
                title={loadError}
                action={<Button onClick={() => void refetch()}>{t("common.retry")}</Button>}
              />
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

              {isAdmin && (
                <Dialog
                  open={laneEditTarget !== null}
                  onOpenChange={(open) => { if (!open) closeLaneEdit() }}
                >
                  <DialogContent className="max-w-md">
                    <DialogHeader>
                      <DialogTitle>{t("projectSettings.share.laneChoiceLegend")}</DialogTitle>
                      <DialogDescription>
                        {laneEditTarget?.name}
                      </DialogDescription>
                    </DialogHeader>
                    {editLanesReady && editLanes.length === 0 ? (
                      <p className="text-xs text-muted-foreground">{t("projectSettings.languages.noAdditionalLanes")}</p>
                    ) : (
                      <TeamLaneChecks
                        lanes={editLanes}
                        selected={laneEditIds}
                        onChange={setLaneEditIds}
                        disabled={laneEditBusy}
                      />
                    )}
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={closeLaneEdit} disabled={laneEditBusy}>
                        {t("common.cancel")}
                      </Button>
                      <Button
                        type="button"
                        onClick={() => void confirmLaneEdit()}
                        disabled={
                          laneEditBusy ||
                          !editLanesReady ||
                          (editLanes.length > 0 && laneEditIds.length === 0)
                        }
                      >
                        {laneEditBusy && <Spinner data-icon="inline-start" />}
                        {laneEditBusy ? t("common.saving") : t("common.save")}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}

              <div className="space-y-3">
              <div
                className={cn(
                  "flex gap-3",
                  teamDescription ? "items-start" : "items-center",
                )}
              >
                <span
                  aria-hidden
                  data-testid="team-detail-avatar"
                  className={cn("shrink-0", teamDescription && "mt-0.5")}
                >
                  <InitialsAvatar name={team.name} size="default" />
                </span>
                <div
                  className={cn(
                    "flex min-w-0 flex-1 justify-between gap-4",
                    teamDescription ? "items-start" : "items-center",
                  )}
                >
                  <div className={cn("min-w-0", teamDescription && "space-y-1")}>
                    {/* AQU-1352 §3.9 rule 1: the scope breadcrumb (org › team) is the title. */}
                    <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">
                      <ScopeBreadcrumb path={teamScopePath} />
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
              </div>

              <Tabs
                value={tab}
                onValueChange={(v) => setTab((v as TeamTab) ?? "projects")}
                className="gap-4 @6xl/team-detail:pl-11"
              >
                <TabsList aria-label={t("org.teamDetail.sectionsAriaLabel")}>
                  <TabsTrigger value="projects">{t("nav.projects")}</TabsTrigger>
                  <TabsTrigger value="members">{t("editor.navTitle.members")}</TabsTrigger>
                  {teamOverviewHref ? (
                    <Link
                      to={teamOverviewHref}
                      onClick={() => setTab("overview")}
                      className={cn(
                        "inline-flex items-center justify-center rounded-md px-2 py-1 text-sm font-medium whitespace-nowrap",
                        tab === "overview"
                          ? "bg-background text-foreground shadow-sm"
                          : "text-foreground/60 hover:text-foreground",
                      )}
                    >
                      {t("editor.navTitle.overview")}
                    </Link>
                  ) : null}
                </TabsList>

                <div className="flex flex-col gap-8">
                <div className="space-y-4" hidden={tab !== "projects" && tab !== "overview"}>
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
{/* AQU-2260: every project in the org, so a search box. */}
                          <SearchSelect
                            aria-label={t("org.teamDetail.projectToAttachAriaLabel")}
                            className="w-full"
                            options={attachableProjects.map((op) => ({ value: op.id, label: op.name }))}
                            value={selectedProjectId}
                            onValueChange={setSelectedProjectId}
                            placeholder={t("org.teamDetail.selectProjectPlaceholder")}
                          />
                          <RoleSelect
                            options={ALL_ROLE_OPTIONS}
                            value={selectedRole}
                            onValueChange={setSelectedRole}
                            aria-label={t("org.teamDetail.grantedRoleAriaLabel")}
                            className="w-full"
                          />
                          <TeamLaneChecks
                            lanes={attachLanes}
                            selected={attachLaneIds}
                            onChange={setAttachLaneIds}
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
                            disabled={
                              !selectedProjectId ||
                              !attachLanesReady ||
                              (attachLanes.length > 0 && attachLaneIds.length === 0)
                            }
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
                      rowLink={{ columnId: "name", to: (p) => `/projects/${p.id}` }}
                      renderRowMenuItems={(p) =>
                        isAdmin ? (
                          <>
                            <MenuItem onClick={() => openProjectRoleChange(p)}>
                              <ShieldUser className="size-4" />
                              {t("org.membersPage.changeRoleAria")}
                            </MenuItem>
                            <MenuItem onClick={() => openLaneEdit(p)}>
                              {t("projectSettings.share.laneChoiceLegend")}
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
                </div>

                <div className="space-y-4" hidden={tab !== "members" && tab !== "overview"}>
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
                            {t("org.access.addPeopleTo", { path: formatScopePath(teamScopePath) })}
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
                          {/* AQU-2238: the picker lists org members only, so an
                              outside person is unreachable through it. This is
                              the direct invite-to-team path — a team-scoped
                              guest grant, no org-roster entry. AQU-1030: the
                              scope sentence names exactly what they will and
                              won't see. */}
                          <FieldSeparator />
                          <Field>
                            <FieldLabel htmlFor="team-add-external">
                              {t("org.teamDetail.outsideOrgLabel")}
                            </FieldLabel>
                            <Input
                              id="team-add-external"
                              autoComplete="off"
                              value={externalIdentifier}
                              placeholder={t("org.teamDetail.outsideOrgPlaceholder")}
                              className="h-9"
                              onChange={(e) => {
                                setAddError(null)
                                setExternalIdentifier(e.target.value)
                              }}
                            />
                          </Field>
                          <GrantScopeNotice sentence={externalGrantSentence} />
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
                            disabled={
                              (stagedUsernames.length === 0 && externalIdentifier.trim().length === 0) ||
                              addBusy
                            }
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
                            align="start"
                            noteClassName="px-2 pb-1.5"
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
                </div>
                </div>
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

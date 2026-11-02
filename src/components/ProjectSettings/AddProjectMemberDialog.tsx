import { useCallback, useEffect, useMemo, useState } from "react"
import { RoleDialog } from "@/components/access/RoleDialog"
import { PermissionDeniedAlert } from "@/components/PermissionDeniedAlert"
import { InviteLinkTab } from "@/components/ProjectSettings/InviteLinkTab"
import { useProjectOrgId } from "@/hooks/useProjectOrgId"
import { useCurrentTargetLanes } from "@/hooks/useCurrentTargetLanes"
import type { MemberLaneAccess } from "@/lib/lanes/lane-access-choice"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { listOrgMembers, type OrgMember } from "@/lib/frontier/orgs"
import { partitionMembers, type ProjectMember } from "@/lib/frontier/members"
import { ROLE } from "@/lib/frontier/roles"
import { MEMBER_GRANT_MIN_ROLE } from "@/lib/frontier/member-grants"
import { toUserFacingError } from "@/lib/errors/user-error"
import type { UseProjectMembers } from "@/hooks/useProjectMembers"
import { useT } from "@/lib/i18n/I18nProvider"
import { formatScopePath } from "@/lib/access/scope-path"
import { grantProjectName } from "@/lib/access/grant-scope-sentence"
import type { ScopePath } from "@/lib/access/types"

/**
 * The "Add a member" dialog from project settings (also the dashboard's
 * Members card and the onboarding invite step). Nested inside the setup
 * sheet it overlays that sheet (Base UI nested dialogs) instead of replacing
 * it with a one-off invite form.
 *
 * AQU-2289: it is the one RoleDialog in its add mode, so its roles are the
 * project list capped at the caller's own role, like every other door.
 */
export function AddProjectMemberDialog({
  projectId,
  open,
  onOpenChange,
  members,
  addMany,
  onAdded,
  scopePath,
  callerLevel,
}: {
  projectId: string
  /** AQU-1352 §3.9 rule 2: when known, the header reads "Add people to <breadcrumb>". */
  scopePath?: ScopePath
  open: boolean
  onOpenChange: (open: boolean) => void
  members: ProjectMember[]
  addMany: UseProjectMembers["addMany"]
  onAdded?: () => void
  /**
   * AQU-853: the caller's own effective role on this project, from the roster
   * MembersSection already renders. Null while unknown. The role picker below
   * is capped by it — the server refuses `role > callerRole.level` with
   * `role_above_caller`, so offering Maintainer to a project_lead just
   * produces a 403 the user cannot act on.
   */
  callerLevel: number | null
}) {
  const t = useT()
  const { session } = useFrontierSession()
  const { orgId: projectOrgId, error: projectOrgError } = useProjectOrgId(projectId)
  const rosterOrgId = projectOrgError ? null : projectOrgId

  const [rosterLoad, setRosterLoad] = useState<{
    key: string | null
    members: OrgMember[]
    error: string | null
  }>({ key: null, members: [], error: null })
  const [addForbidden, setAddForbidden] = useState(false)
  const rosterKey = open && session?.username && rosterOrgId != null
    ? `${session.username}\u0000${rosterOrgId}`
    : null
  const visibleOrgMembers = useMemo(
    () => rosterLoad.key === rosterKey ? rosterLoad.members : [],
    [rosterKey, rosterLoad],
  )
  const rosterError = rosterLoad.key === rosterKey ? rosterLoad.error : null

  useEffect(() => {
    const jwt = session?.jwt
    if (!open || !jwt || rosterOrgId == null || rosterKey == null) return
    let alive = true
    listOrgMembers(jwt, rosterOrgId)
      .then((members) => {
        if (!alive) return
        setRosterLoad({ key: rosterKey, members, error: null })
      })
      .catch((error) => {
        if (!alive) return
        setRosterLoad({
          key: rosterKey,
          members: [],
          error: toUserFacingError(error, "organization members").message,
        })
      })
    return () => { alive = false }
  }, [open, rosterKey, rosterOrgId, session?.jwt])

  const { projectMembers } = partitionMembers(members)
  const directGrantUserIds = useMemo(
    () => new Set(projectMembers.map((m) => m.userId)),
    [projectMembers],
  )
  const eligibleOrgMembers = useMemo(
    () =>
      visibleOrgMembers
        .filter((m) => !directGrantUserIds.has(m.userId))
        .sort((a, b) =>
          a.username.localeCompare(b.username, undefined, { sensitivity: "base" }),
        ),
    [visibleOrgMembers, directGrantUserIds],
  )

  const { lanes: targetLanes } = useCurrentTargetLanes(open ? projectId : null)
  const projectName = grantProjectName(
    t,
    scopePath?.find((crumb) => crumb.type === "project" && !crumb.hidden)?.name,
  )

  const handleAddMany = useCallback(async (
    usernames: string[],
    role: number,
    laneAccess?: MemberLaneAccess,
  ) => {
    const results = await addMany(usernames.map((username) => ({
      username,
      role,
      ...(laneAccess ? { laneAccess } : {}),
    })))
    return results.map((r) => ({
      username: r.username,
      ok: r.ok,
      error: r.error?.message,
    }))
  }, [addMany])

  return (
    <RoleDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setAddForbidden(false)
      }}
      mode="add"
      level="project"
      callerLevel={callerLevel}
      title={scopePath?.length
        ? t("org.access.addPeopleTo", { path: formatScopePath(scopePath) })
        : t("org.membersPage.orgTable.addMemberTitle")}
      summary={t("projectSettings.members.addDialogDescription")}
      lead={(projectOrgError ?? rosterError) ? (
        <p role="alert" className="text-xs text-destructive">
          {projectOrgError ?? rosterError}
        </p>
      ) : null}
      people={{
        kind: "row",
        row: {
          defaultRole: ROLE.CONTRIBUTOR,
          grantScope: { kind: "project", projectName, lanes: "all" },
          targetLanes,
          onAdd: async (usernames, role, laneAccess) => {
            const outcomes = await handleAddMany(usernames, role, laneAccess)
            if (outcomes.some((o) => o.ok)) onAdded?.()
            if (outcomes.every((o) => o.ok)) onOpenChange(false)
            return outcomes
          },
          excludedUserIds: [...directGrantUserIds],
          suggestions:
            visibleOrgMembers.length > 0
              ? eligibleOrgMembers.map((m) => ({ id: m.userId, username: m.username }))
              : undefined,
          emptySuggestionsHint: t("org.membersPage.allOrgMembersAdded"),
          onAddStart: () => setAddForbidden(false),
          onBatchErrorMessage: (e) => {
            const uf = toUserFacingError(e, "project")
            if (uf.category === "forbidden") {
              setAddForbidden(true)
              return null
            }
            return uf.message
          },
        },
      }}
      note={addForbidden ? (
        <PermissionDeniedAlert
          action="org.membersPage.addMembersAction"
          // AQU-853: the server's floor for granting membership is
          // project_lead (500), not maintainer — naming the wrong role
          // sends the user to ask for more access than they need.
          requiredRoleLevel={MEMBER_GRANT_MIN_ROLE}
        />
      ) : null}
      otherTabs={[{
        value: "invite",
        label: t("projectSettings.share.tabInviteLink"),
        content: <InviteLinkTab projectId={projectId} projectName={projectName} embedded />,
      }]}
    />
  )
}

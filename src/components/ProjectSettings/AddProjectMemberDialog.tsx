import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { MemberMultiAddRow } from "@/components/MemberMultiAddRow"
import { PermissionDeniedAlert } from "@/components/PermissionDeniedAlert"
import { InviteLinkTab } from "@/components/ProjectMembersPage"
import { useProjectOrgId } from "@/hooks/useProjectOrgId"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { listOrgMembers, type OrgMember } from "@/lib/frontier/orgs"
import { partitionMembers, type ProjectMember } from "@/lib/frontier/members"
import { ROLE, PROJECT_ROLE_OPTIONS } from "@/lib/frontier/roles"
import { toUserFacingError } from "@/lib/errors/user-error"
import type { UseProjectMembers } from "@/hooks/useProjectMembers"
import { useT } from "@/lib/i18n/I18nProvider"

type AddDialogTab = "members" | "invite"

/**
 * The "Add a member" dialog from project settings. Nested inside the setup
 * sheet it overlays that sheet (Base UI nested dialogs) instead of replacing
 * it with a one-off invite form.
 */
export function AddProjectMemberDialog({
  projectId,
  open,
  onOpenChange,
  members,
  addMany,
  onAdded,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  members: ProjectMember[]
  addMany: UseProjectMembers["addMany"]
  onAdded?: () => void
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
  const [addTab, setAddTab] = useState<AddDialogTab>("members")
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

  const grantableRoles = PROJECT_ROLE_OPTIONS.filter((r) => r.level <= ROLE.MAINTAINER)

  const handleAddMany = useCallback(async (usernames: string[], role: number) => {
    const results = await addMany(usernames.map((username) => ({ username, role })))
    return results.map((r) => ({
      username: r.username,
      ok: r.ok,
      error: r.error?.message,
    }))
  }, [addMany])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          setAddForbidden(false)
          setAddTab("members")
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("org.membersPage.orgTable.addMemberTitle")}</DialogTitle>
          <DialogDescription>
            {t("projectSettings.members.addDialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={addTab}
          onValueChange={(v) => setAddTab((v as AddDialogTab) ?? "members")}
          className="gap-3"
        >
          <TabsList size="lg" className="w-full" aria-label={t("org.membersPage.orgTable.addMethodAriaLabel")}>
            <TabsTrigger value="members">{t("org.membersPage.orgTable.addMembersTab")}</TabsTrigger>
            <TabsTrigger value="invite">{t("projectSettings.share.tabInviteLink")}</TabsTrigger>
          </TabsList>
          <TabsContent value="members" className="space-y-3">
            {(projectOrgError ?? rosterError) && (
              <p role="alert" className="text-xs text-destructive">
                {projectOrgError ?? rosterError}
              </p>
            )}
            <MemberMultiAddRow
              roleOptions={grantableRoles}
              defaultRole={ROLE.CONTRIBUTOR}
              onAdd={async (usernames, role) => {
                const outcomes = await handleAddMany(usernames, role)
                if (outcomes.some((o) => o.ok)) onAdded?.()
                if (outcomes.every((o) => o.ok)) onOpenChange(false)
                return outcomes
              }}
              excludedUserIds={[...directGrantUserIds]}
              suggestions={
                visibleOrgMembers.length > 0
                  ? eligibleOrgMembers.map((m) => ({ id: m.userId, username: m.username }))
                  : undefined
              }
              emptySuggestionsHint="All org members are already on this project."
              onAddStart={() => setAddForbidden(false)}
              onBatchErrorMessage={(e) => {
                const uf = toUserFacingError(e, "project")
                if (uf.category === "forbidden") {
                  setAddForbidden(true)
                  return null
                }
                return uf.message
              }}
            />
            {addForbidden && (
              <PermissionDeniedAlert
                action="org.membersPage.addMembersAction"
                requiredRoleLevel={ROLE.MAINTAINER}
              />
            )}
          </TabsContent>
          <TabsContent value="invite">
            <InviteLinkTab projectId={projectId} embedded />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

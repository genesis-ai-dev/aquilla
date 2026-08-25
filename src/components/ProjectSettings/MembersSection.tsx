// Project settings — Members pane (DataTable roster).
//
// Lives at `/project/:id/settings/members`. Uses the shared DataTable
// (search + TanStack sort headers). "Add a member" opens a dialog with tabs:
// add people from the org, or create an invite link.

import { useCallback, useEffect, useMemo, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import {
  AlertTriangle, ShieldOff, ShieldUser, UserMinus,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import {
  DataTable,
  DataTableColumnHeader,
  DataTableRowActionsButton,
} from "@/components/ui/data-table"
import { missingLast, SORT_MISSING_LAST } from "@/components/ui/data-table-missing"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import {
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from "@/components/ui/menu-parts"
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { MemberMultiAddRow } from "@/components/MemberMultiAddRow"
import { PermissionDeniedAlert } from "@/components/PermissionDeniedAlert"
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog"
import { RoleLabel } from "@/components/RoleLabel"
import {
  InviteLinkTab, RevokeAllDialog,
} from "@/components/ProjectMembersPage"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { useProjectOrgId } from "@/hooks/useProjectOrgId"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { listOrgMembers, type OrgMember } from "@/lib/frontier/orgs"
import { partitionMembers, type ProjectMember } from "@/lib/frontier/members"
import {
  ROLE, PROJECT_ROLE_OPTIONS, humanRoleName, roleDescription, roleDisplayText,
} from "@/lib/frontier/roles"
import { toUserFacingError } from "@/lib/errors/user-error"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

// Access-source annotation shown under a member's name — how they got access
// to this project. Reuses org.membersPage.source* (org.ts) rather than
// minting duplicates: the same four grant paths are already named there for
// the org-level Members page this table mirrors.
const SOURCE_LABEL_KEYS: Record<string, MessageKey> = {
  override: "org.membersPage.sourceDirectInvite",
  group: "org.membersPage.sourceViaTeam",
  org: "org.membersPage.sourceViaOrg",
  creator: "org.membersPage.sourceProjectCreator",
}

type AccessFilter = "all" | "project" | "org"
type AddDialogTab = "members" | "invite"

function memberMatchesFilter(m: ProjectMember, filter: AccessFilter): boolean {
  if (filter === "all") return true
  const paths = [m.role.source, ...(m.secondarySources ?? []).map((s) => s.source)]
  const hasProjectPath = paths.some(
    (s) => s === "override" || s === "group" || s === "creator",
  )
  return filter === "project" ? hasProjectPath : !hasProjectPath
}

function MemberRoleBadge({ name, level }: { name: string; level: number }) {
  const elevated = level >= ROLE.MAINTAINER
  return (
    <Badge
      variant="secondary"
      className={cn(
        "font-normal",
        elevated
          ? "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300"
          : "bg-muted text-muted-foreground",
      )}
    >
      {roleDisplayText(name)}
    </Badge>
  )
}

export function MembersSection({ projectId }: { projectId: string }) {
  const t = useT()
  const { session } = useFrontierSession()
  const {
    members, isLoading, error, rosterHidden, refresh, add, addMany, remove,
  } = useProjectMembers(projectId)

  const callerMaxRole = ROLE.MAINTAINER
  const callerUsername = session?.username ?? null
  const hasJwt = Boolean(session?.jwt)

  const { orgId: projectOrgId, error: projectOrgError } = useProjectOrgId(projectId)
  const rosterOrgId = projectOrgError ? null : projectOrgId

  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([])
  useEffect(() => {
    const jwt = session?.jwt
    if (!jwt || rosterOrgId == null) {
      setOrgMembers((prev) => (prev.length === 0 ? prev : []))
      return
    }
    let alive = true
    listOrgMembers(jwt, rosterOrgId)
      .then((ms) => { if (alive) setOrgMembers(ms) })
      .catch(() => { /* suggestions best-effort */ })
    return () => { alive = false }
  }, [session?.jwt, rosterOrgId])

  const [accessFilter, setAccessFilter] = useState<AccessFilter>("all")
  const [addOpen, setAddOpen] = useState(false)
  const [addTab, setAddTab] = useState<AddDialogTab>("members")
  const [addForbidden, setAddForbidden] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<ProjectMember | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<ProjectMember | null>(null)

  const { projectMembers } = partitionMembers(members)
  const directGrantUserIds = useMemo(
    () => new Set(projectMembers.map((m) => m.userId)),
    [projectMembers],
  )
  const eligibleOrgMembers = useMemo(
    () =>
      orgMembers
        .filter((m) => !directGrantUserIds.has(m.userId))
        .sort((a, b) =>
          a.username.localeCompare(b.username, undefined, { sensitivity: "base" }),
        ),
    [orgMembers, directGrantUserIds],
  )

  const grantableRoles = PROJECT_ROLE_OPTIONS.filter((r) => r.level <= callerMaxRole)

  const tableData = useMemo(
    () => members.filter((m) => memberMatchesFilter(m, accessFilter)),
    [members, accessFilter],
  )

  const handleAddMany = useCallback(async (usernames: string[], role: number) => {
    const results = await addMany(usernames.map((username) => ({ username, role })))
    return results.map((r) => ({
      username: r.username,
      ok: r.ok,
      error: r.error?.message,
    }))
  }, [addMany])

  const openAddDialog = () => {
    setAddForbidden(false)
    setAddTab("members")
    setAddOpen(true)
  }

  const columns = useMemo<ColumnDef<ProjectMember>[]>(
    () => [
      {
        id: "name",
        accessorFn: (m) => m.username.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.name")} />,
        meta: { className: "min-w-0 w-[50%]" },
        cell: ({ row }) => {
          const m = row.original
          const sourceKey = SOURCE_LABEL_KEYS[m.role.source]
          return (
            <UsernameWithAvatar username={m.username}>
              <span className="truncate text-xs font-normal text-muted-foreground">
                {sourceKey ? t(sourceKey) : m.role.source}
              </span>
            </UsernameWithAvatar>
          )
        },
      },
      {
        id: "email",
        accessorFn: (m) => missingLast((m.email ?? "").toLowerCase()),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.email")} />,
        meta: { className: "min-w-0 w-[35%]" },
        cell: ({ row }) => (
          <span className="block truncate text-muted-foreground">
            {row.original.email?.trim() ? row.original.email : "—"}
          </span>
        ),
      },
      {
        id: "role",
        accessorFn: (m) => m.role.level,
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.roleLabel")} />,
        meta: { className: "w-0 whitespace-nowrap" },
        cell: ({ row }) => (
          <MemberRoleBadge name={row.original.role.name} level={row.original.role.level} />
        ),
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">{t("org.overviewLaneTable.actionsColumn")}</span>,
        meta: { align: "right" as const, className: "w-10" },
        cell: ({ row }) => {
          const m = row.original
          return (
            <DataTableRowActionsButton
              label={t("projectSettings.members.actionsForRow", { username: m.username })}
              revealOnHover
            />
          )
        },
      },
    ],
    [t],
  )

  // AQU-485: below-floor callers must not see this pane at all (ProjectSettings
  // omits the nav row). If we still mount — a stale deep-link, or a race
  // before the org-settings fetch settles — render nothing. Do not disclose
  // that a restricted roster exists.
  if (rosterHidden) return null

  return (
    <>
      <div id="section-members" data-testid="settings-members-section" className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
            <button
              type="button"
              className="ml-auto text-xs underline"
              onClick={() => void refresh()}
            >
              {t("common.retry")}
            </button>
          </div>
        )}

        {isLoading && members.length === 0 ? (
          <LoadingPanel label={t("org.membersPage.loadingMembers")} className="min-h-48" />
        ) : (
          <DataTable
            columns={columns}
            data={tableData}
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
              <>
                <Select
                  items={[
                    { value: "all", label: t("org.orgHome.statusFilter.all") },
                    { value: "project", label: t("projectSettings.members.filterProjectGrants") },
                    { value: "org", label: t("projectSettings.members.filterViaOrg") },
                  ]}
                  value={accessFilter}
                  onValueChange={(v) => setAccessFilter((v as AccessFilter) ?? "all")}
                >
                  <SelectTrigger className="bg-card" aria-label={t("projectSettings.members.filterAriaLabel")}>
                    <SelectValue className="flex-none" />
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectGroup>
                      <SelectItem value="all">{t("org.orgHome.statusFilter.all")}</SelectItem>
                      <SelectItem value="project">{t("projectSettings.members.filterProjectGrants")}</SelectItem>
                      <SelectItem value="org">{t("projectSettings.members.filterViaOrg")}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  className="ml-auto shrink-0"
                  onClick={openAddDialog}
                >
                  {t("org.membersPage.orgTable.addMemberTitle")}
                </Button>
              </>
            }
            rowClassName="group"
            renderRowMenuItems={(m) => {
              const isSelf = callerUsername !== null && m.username === callerUsername
              const isLocked = m.role.source === "org" || m.role.source === "creator"
              const canRemoveDirect =
                !isLocked && !isSelf && m.role.source === "override"
              const canChangeRole = !isLocked && !isSelf
              return (
                <>
                  {canChangeRole && (
                    <MenuSub>
                      <MenuSubTrigger>
                        <ShieldUser className="size-4" />
                        {t("org.membersPage.changeRoleAria")}
                      </MenuSubTrigger>
                      <MenuSubContent className="min-w-72 max-w-96">
                        {grantableRoles.map((r) => (
                          <MenuItem
                            key={r.level}
                            onClick={() => void add(m.username, r.level)}
                            className="items-start"
                          >
                            <span className="flex min-w-0 flex-col gap-0.5">
                              <span>
                                <RoleLabel name={r.name} className="font-medium" />
                                {r.level === m.role.level ? " (current)" : ""}
                              </span>
                              <span className="text-xs font-normal whitespace-normal text-muted-foreground">
                                {roleDescription(r.level)}
                              </span>
                            </span>
                          </MenuItem>
                        ))}
                      </MenuSubContent>
                    </MenuSub>
                  )}
                  {canRemoveDirect && (
                    <MenuItem onClick={() => setRemoveTarget(m)}>
                      <UserMinus className="size-4" />
                      {t("projectSettings.members.removeDirectAccess")}
                    </MenuItem>
                  )}
                  {hasJwt && !isSelf && (
                    <>
                      {(canChangeRole || canRemoveDirect) && <MenuSeparator />}
                      <MenuItem
                        variant="destructive"
                        onClick={() => setRevokeTarget(m)}
                      >
                        <ShieldOff className="size-4" />
                        {t("projectSettings.members.revokeAllAccess")}
                      </MenuItem>
                    </>
                  )}
                  {!canChangeRole && !canRemoveDirect && !(hasJwt && !isSelf) && (
                    <MenuItem disabled>{t("projectSettings.members.noActionsAvailable")}</MenuItem>
                  )}
                </>
              )
            }}
            emptyState={
              <p className="py-10 text-center text-sm text-muted-foreground">
                {members.length === 0
                  ? "No members yet. Add someone to grant project access."
                  : "No members match this filter."}
              </p>
            }
            testId="settings-members-table"
            className={ADMIN_TABLE_PANEL_CLASS}
            dense
          />
        )}
      </div>

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open)
          if (!open) {
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
              <MemberMultiAddRow
                roleOptions={grantableRoles}
                defaultRole={ROLE.CONTRIBUTOR}
                onAdd={async (usernames, role) => {
                  const outcomes = await handleAddMany(usernames, role)
                  if (outcomes.every((o) => o.ok)) setAddOpen(false)
                  return outcomes
                }}
                excludedUserIds={[...directGrantUserIds]}
                suggestions={
                  orgMembers.length > 0
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

      <ConfirmActionDialog
        open={removeTarget !== null}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null) }}
        title={t("org.membersPage.removeMemberTitle")}
        description={
          removeTarget
            ? `Remove ${removeTarget.username}'s direct ${humanRoleName(removeTarget.role.level)} access to this project? Any access via org, team, or creator status is unaffected — use "Revoke all" to review every path.`
            : ""
        }
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={() => {
          if (removeTarget) void remove(removeTarget.userId)
          setRemoveTarget(null)
        }}
      />

      {revokeTarget && (
        <RevokeAllDialog
          member={revokeTarget}
          projectId={projectId}
          onClose={() => setRevokeTarget(null)}
          onRevoked={() => {
            setRevokeTarget(null)
            void refresh()
          }}
        />
      )}
    </>
  )
}

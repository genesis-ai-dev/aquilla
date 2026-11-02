import { useCallback, useMemo, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { ChevronDown, ChevronRight, ShieldUser, UserMinus, UserPlus } from "lucide-react"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"
import { RoleDialog } from "@/components/access/RoleDialog"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { OrgInviteByEmail } from "@/components/org/OrgInviteByEmail"
import { MemberAccessSubRow } from "@/components/org/MemberAccessPanel"
import { MemberInspectorTrigger } from "@/components/access/MemberInspectorTrigger"
import { GrantOriginBadge } from "@/components/access/GrantOriginBadge"
import { DisabledFieldTooltip } from "@/components/ProjectSettings/DisabledFieldTooltip"
import { Button } from "@/components/ui/button"
import {
  DataTable,
  DataTableColumnHeader,
  DataTableRowActionsButton,
} from "@/components/ui/data-table"
import { missingLast, SORT_MISSING_LAST } from "@/components/ui/data-table-missing"
import { MenuItem, MenuSeparator } from "@/components/ui/menu-parts"
import { TableEmptyState } from "@/components/ui/page"
import { toast } from "@/components/ui/toast"
import { NoteOnClick } from "@/components/ui/info-note"
import { RoleLabel } from "@/components/RoleLabel"
import { toUserFacingError } from "@/lib/errors/user-error"
import type { MemberGrantResult } from "@/lib/frontier/members"
import type { OrgMember } from "@/lib/frontier/orgs"
import {
  ALL_ROLE_LEVELS,
  humanRoleName,
  ROLE,
  roleDisplayText,
  roleHelpText,
  roleName,
} from "@/lib/frontier/roles"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"
import { useT } from "@/lib/i18n/I18nProvider"

// Shown on the disabled row-menu Remove item when the caller is not an org owner.
const REMOVE_REQUIRES_OWNER_TOOLTIP =
  "Only org owners can remove members from the organization. Ask an owner to remove someone."

// AQU-952: promoting someone to Owner is the workspace-handover path — a
// partner that Frontier pre-loaded a workspace for can be given full admin
// without rebuilding the workspace. It is additive (the promoting owner keeps
// their own ownership, so the loaded workspace is never orphaned) and this
// table cannot undo it: the row menu hides Change role and Remove for members
// who are already owners. RoleDialog warns before saving it (AQU-2289).

function roleLabel(roleLevel: number | null | undefined): string {
  if (roleLevel == null) return "Unknown"
  return ALL_ROLE_LEVELS.includes(roleLevel as (typeof ALL_ROLE_LEVELS)[number])
    ? roleDisplayText(roleName(roleLevel))
    : humanRoleName(roleLevel)
}

function lockedOrgRoleTooltip(roleLevel: number | null | undefined): string {
  const help = roleLevel != null ? roleHelpText(roleLevel) : ""
  const prefix = help || "This member's org-level role is unknown."
  return `${prefix} This permission is set at the org level and can only be changed by an org owner.`
}

function CopyEmailButton({ email }: { email: string }) {
  const t = useT()
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

export function OrgMembersTable({
  orgId,
  members,
  callerOrgRoleLevel,
  canAddToProjects,
  onAddToProjects,
  add,
  addMany,
  onRequestRemove,
  loading = false,
  orgName,
}: {
  orgId: number
  /** AQU-1352: names the "Effective here" scope in the member inspector. */
  orgName?: string
  members: OrgMember[]
  callerOrgRoleLevel: number | null
  canAddToProjects: boolean
  onAddToProjects: () => void
  add: (username: string, role: number) => Promise<unknown>
  addMany: (members: Array<{ username: string; role: number }>) => Promise<MemberGrantResult[]>
  onRequestRemove: (userId: number, username: string) => void
  loading?: boolean
}) {
  const t = useT()
  const isOwner = (callerOrgRoleLevel ?? 0) >= ROLE.OWNER
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [adding, setAdding] = useState(false)
  const [roleChangeTarget, setRoleChangeTarget] = useState<OrgMember | null>(null)

  const toggleExpand = useCallback((userId: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }, [])

  function closeAdd() {
    setAdding(false)
  }

  const columns = useMemo<ColumnDef<OrgMember>[]>(
    () => [
      {
        id: "name",
        accessorFn: (m) => m.username.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.name")} />,
        meta: { className: "min-w-0" },
        cell: ({ row }) => {
          const m = row.original
          const isOpen = expanded.has(m.userId)
          return (
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                aria-expanded={isOpen}
                aria-label={t("org.membersPage.orgTable.projectAccessAriaLabel", { username: m.username })}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleExpand(m.userId)
                }}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {isOpen ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
              </button>
              <MemberInspectorTrigger
                userId={m.userId}
                username={m.username}
                from={{ type: "org", id: String(orgId) }}
                herePath={[{ type: "org", id: String(orgId), name: orgName ?? t("org.access.scope.org") }]}
                onManageAccess={() => {
                  if (!expanded.has(m.userId)) toggleExpand(m.userId)
                }}
              >
                <UsernameWithAvatar userId={m.userId} username={m.username} size="xs" nameClassName="font-normal" />
              </MemberInspectorTrigger>
            </div>
          )
        },
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
        accessorFn: (m) => m.role.level,
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("common.roleLabel")} />,
        meta: { className: "w-[11rem] whitespace-nowrap" },
        cell: ({ row }) => {
          const m = row.original
          const label = <RoleLabel name={m.role.level} />
          // AQU-1352 §3.7 rule 1: org is the top scope, so org rows are always direct.
          const badge = <GrantOriginBadge origin={{ kind: "direct" }} />
          if (isOwner) return <span className="inline-flex items-center gap-2">{label}{badge}</span>
          return (
            <span className="inline-flex items-center gap-2">
              {/* AQU-2260: why it is read-only opens on click, never on hover. */}
              <NoteOnClick
                note={lockedOrgRoleTooltip(m.role.level)}
                label={t("org.teamDetail.orgLevelRoleAriaLabel", { role: roleLabel(m.role.level) })}
              >
                {label}
              </NoteOnClick>
              {badge}
            </span>
          )
        },
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
    [expanded, isOwner, t, toggleExpand],
  )

  return (
    <>
      {isOwner && (
        <RoleDialog
          open={roleChangeTarget !== null}
          onOpenChange={(open) => { if (!open) setRoleChangeTarget(null) }}
          mode="change"
          level="org"
          callerLevel={callerOrgRoleLevel}
          name={roleChangeTarget?.username ?? ""}
          currentLevel={roleChangeTarget?.role.level ?? null}
          summary={t("org.roleDialog.orgChangeSummary")}
          details={t("org.roleDialog.orgRoleDetails")}
          onSave={async (level) => {
            if (roleChangeTarget) await add(roleChangeTarget.username, level)
          }}
          errorMessage={(e) => {
            const uf = toUserFacingError(e, "org")
            return uf.category === "forbidden" ? t("org.roleDialog.orgChangeForbidden") : uf.message
          }}
        />
      )}

      {isOwner && (
        <RoleDialog
          open={adding}
          onOpenChange={(open) => { if (!open) closeAdd() }}
          mode="add"
          level="org"
          callerLevel={callerOrgRoleLevel}
          title={t("org.membersPage.orgTable.addMemberTitle")}
          summary={t("org.roleDialog.orgAddSummary")}
          details={t("org.roleDialog.orgRoleDetails")}
          people={{
            kind: "row",
            row: {
              defaultRole: ROLE.CONTRIBUTOR,
              grantScope: { kind: "organization" },
              scopedUserSearch: false,
              excludedUserIds: members.map((m) => m.userId),
              onAdd: async (usernames, role) => {
                const results = await addMany(usernames.map((username) => ({ username, role })))
                const outcomes = results.map((r) => ({
                  username: r.username,
                  ok: r.ok,
                  error: r.error?.message,
                }))
                if (outcomes.length > 0 && outcomes.every((o) => o.ok)) closeAdd()
                return outcomes
              },
              onBatchErrorMessage: (e) => {
                const uf = toUserFacingError(e, "org")
                return uf.category === "forbidden" ? t("org.roleDialog.orgAddForbidden") : uf.message
              },
            },
          }}
          otherTabs={[{
            value: "invite",
            label: t("org.membersPage.orgTable.inviteByEmailTab"),
            content: <OrgInviteByEmail orgId={orgId} />,
          }]}
        />
      )}

      <DataTable
          columns={columns}
          data={members}
          loading={loading}
          loadingLabel={t("org.membersPage.loadingMembers")}
          getRowId={(m) => String(m.userId)}
          getRowAttributes={(m) => ({ "data-user-id": String(m.userId) })}
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
              {canAddToProjects ? (
                <Button
                  type="button"
                  variant="outline"
                  className="ml-auto shrink-0"
                  onClick={onAddToProjects}
                >
                  <UserPlus className="mr-1.5 size-4" />
                  {t("org.membersPage.orgPage.addToProjectsButton")}
                </Button>
              ) : null}
              {isOwner ? (
                <Button
                  className={canAddToProjects ? "shrink-0" : "ml-auto shrink-0"}
                  onClick={() => setAdding(true)}
                >
                  {t("org.membersPage.orgTable.addMemberTitle")}
                </Button>
              ) : null}
            </>
          }
          rowClassName="group"
          renderRowMenuItems={(m) => {
            const isOrgOwner = m.role.level === ROLE.OWNER
            const canRemove = isOwner && !isOrgOwner
            return (
              <>
                {isOwner && !isOrgOwner && (
                  <>
                    <MenuItem onClick={() => setRoleChangeTarget(m)}>
                      <ShieldUser className="size-4" />
                      {t("org.membersPage.changeRoleAria")}
                    </MenuItem>
                    <MenuSeparator />
                  </>
                )}
                <DisabledFieldTooltip
                  disabled={!canRemove}
                  align="start"
                  noteClassName="px-2 pb-1.5"
                  tooltip={!isOwner ? REMOVE_REQUIRES_OWNER_TOOLTIP : undefined}
                >
                  <MenuItem
                    aria-label={
                      canRemove
                        ? undefined
                        : t("org.membersPage.orgTable.removeOwnersOnlyAriaLabel", { username: m.username })
                    }
                    disabled={!canRemove}
                    onClick={() => {
                      if (canRemove) onRequestRemove(m.userId, m.username)
                    }}
                  >
                    <UserMinus className="size-4" />
                    {t("org.membersPage.orgTable.removeFromOrg")}
                  </MenuItem>
                </DisabledFieldTooltip>
              </>
            )
          }}
          renderSubRow={(m) =>
            expanded.has(m.userId) ? (
              <MemberAccessSubRow
                orgId={orgId}
                userId={m.userId}
                callerOrgRoleLevel={callerOrgRoleLevel}
                colSpan={4}
              />
            ) : null
          }
          emptyState={
            members.length === 0 ? (
              <TableEmptyState
                icon={NAV_PAGE_ICONS.members}
                title={t("org.membersPage.orgTable.noMembersTitle")}
                description={
                  isOwner
                    ? "Add people by username, or invite someone by email."
                    : "An org owner can add members to this organization."
                }
              />
            ) : (
              <div className="flex flex-col items-center gap-3 py-10">
                <p className="text-center text-sm text-muted-foreground">
                  {t("org.membersPage.orgTable.noSearchMatch")}
                </p>
              </div>
            )
          }
          testId="org-members-table"
          className={ADMIN_TABLE_PANEL_CLASS}
          dense
        />
    </>
  )
}

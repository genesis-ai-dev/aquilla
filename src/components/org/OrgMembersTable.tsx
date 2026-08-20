import { useCallback, useMemo, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { ChevronDown, ChevronRight, ShieldUser, UserMinus, UserPlus } from "lucide-react"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"
import { MemberMultiAddRow } from "@/components/MemberMultiAddRow"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { OrgInviteByEmail } from "@/components/org/OrgInviteByEmail"
import { MemberAccessSubRow } from "@/components/org/MemberAccessPanel"
import { DisabledFieldTooltip } from "@/components/ProjectSettings/DisabledFieldTooltip"
import { Button } from "@/components/ui/button"
import {
  DataTable,
  DataTableColumnHeader,
  DataTableRowActionsButton,
} from "@/components/ui/data-table"
import { missingLast, SORT_MISSING_LAST } from "@/components/ui/data-table-missing"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { MenuItem, MenuSeparator } from "@/components/ui/menu-parts"
import { TableEmptyState } from "@/components/ui/page"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "@/components/ui/toast"
import { AppTooltip } from "@/components/ui/tooltip"
import { RoleSelect } from "@/components/RoleSelect"
import { toUserFacingError } from "@/lib/errors/user-error"
import type { MemberGrantResult } from "@/lib/frontier/members"
import type { OrgMember } from "@/lib/frontier/orgs"
import {
  ALL_ROLE_LEVELS,
  humanRoleName,
  ORG_ROLE_OPTIONS,
  ROLE,
  roleDisplayText,
  roleHelpText,
  roleName,
} from "@/lib/frontier/roles"
import { NAV_PAGE_ICONS } from "@/lib/navigation/page-icons"
import { useT } from "@/lib/i18n/I18nProvider"

type AddDialogTab = "members" | "invite"

// Shown on the disabled row-menu Remove item when the caller is not an org owner.
const REMOVE_REQUIRES_OWNER_TOOLTIP =
  "Only org owners can remove members from the organization. Ask an owner to remove someone."

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
}: {
  orgId: number
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
  const [addTab, setAddTab] = useState<AddDialogTab>("members")
  const [roleChangeTarget, setRoleChangeTarget] = useState<OrgMember | null>(null)
  const [roleChangeLevel, setRoleChangeLevel] = useState("")
  const [roleChangeBusy, setRoleChangeBusy] = useState(false)
  const [roleError, setRoleError] = useState<string | null>(null)

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
    setAddTab("members")
  }

  function openRoleChange(member: OrgMember) {
    setRoleError(null)
    setRoleChangeTarget(member)
    setRoleChangeLevel(String(member.role.level))
  }

  function closeRoleChange() {
    setRoleChangeTarget(null)
    setRoleChangeLevel("")
    setRoleChangeBusy(false)
    setRoleError(null)
  }

  async function confirmRoleChange() {
    if (!roleChangeTarget || !roleChangeLevel) return
    setRoleChangeBusy(true)
    setRoleError(null)
    try {
      await add(roleChangeTarget.username, Number(roleChangeLevel))
      closeRoleChange()
    } catch (e) {
      const uf = toUserFacingError(e, "org")
      setRoleError(
        uf.category === "forbidden"
          ? "Only org owners can change member roles."
          : uf.message,
      )
    } finally {
      setRoleChangeBusy(false)
    }
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
              <UsernameWithAvatar username={m.username} size="xs" nameClassName="font-normal" />
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
        meta: { className: "w-[7.5rem] whitespace-nowrap" },
        cell: ({ row }) => {
          const m = row.original
          const label = (
            <span className="text-sm text-foreground">{roleLabel(m.role.level)}</span>
          )
          if (isOwner) return label
          return (
            <AppTooltip content={lockedOrgRoleTooltip(m.role.level)} className="max-w-xs">
              <span
                tabIndex={0}
                className="inline-flex cursor-help"
                aria-label={t("org.teamDetail.orgLevelRoleAriaLabel", { role: roleLabel(m.role.level) })}
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
        <Dialog
          open={roleChangeTarget !== null}
          onOpenChange={(open) => { if (!open) closeRoleChange() }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {t("org.membersPage.changeRoleAria")}{roleChangeTarget ? ` for ${roleChangeTarget.username}` : ""}
              </DialogTitle>
              <DialogDescription>
                {t("org.membersPage.orgTable.changeRoleDescription")}
              </DialogDescription>
            </DialogHeader>
            <RoleSelect
              options={ORG_ROLE_OPTIONS}
              value={roleChangeLevel ? Number(roleChangeLevel) : null}
              onValueChange={(level) => setRoleChangeLevel(String(level))}
              className="w-full!"
              aria-label={
                roleChangeTarget
                  ? `Role for ${roleChangeTarget.username}`
                  : "New role"
              }
            />
            {roleError && (
              <p role="alert" className="text-xs text-destructive">{roleError}</p>
            )}
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

      {isOwner && (
        <Dialog open={adding} onOpenChange={(open) => { if (!open) closeAdd() }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{t("org.membersPage.orgTable.addMemberTitle")}</DialogTitle>
              <DialogDescription>
                {t("org.membersPage.orgTable.addMemberDescription")}
              </DialogDescription>
            </DialogHeader>
            <Tabs
              value={addTab}
              onValueChange={(v) => setAddTab((v as AddDialogTab) ?? "members")}
              className="gap-3"
            >
              <TabsList size="lg" className="w-full" aria-label={t("org.membersPage.orgTable.addMethodAriaLabel")}>
                <TabsTrigger value="members">{t("org.membersPage.orgTable.addMembersTab")}</TabsTrigger>
                <TabsTrigger value="invite">{t("org.membersPage.orgTable.inviteByEmailTab")}</TabsTrigger>
              </TabsList>
              <TabsContent value="members">
                <MemberMultiAddRow
                  roleOptions={ORG_ROLE_OPTIONS}
                  defaultRole={ROLE.MAINTAINER}
                  scopedUserSearch={false}
                  excludedUserIds={members.map((m) => m.userId)}
                  onAdd={async (usernames, role) => {
                    const results = await addMany(usernames.map((username) => ({ username, role })))
                    const outcomes = results.map((r) => ({
                      username: r.username,
                      ok: r.ok,
                      error: r.error?.message,
                    }))
                    if (outcomes.length > 0 && outcomes.every((o) => o.ok)) closeAdd()
                    return outcomes
                  }}
                  onBatchErrorMessage={(e) => {
                    const uf = toUserFacingError(e, "org")
                    return uf.category === "forbidden"
                      ? "Only org owners can add members."
                      : uf.message
                  }}
                />
              </TabsContent>
              <TabsContent value="invite">
                <OrgInviteByEmail orgId={orgId} />
              </TabsContent>
            </Tabs>
          </DialogContent>
        </Dialog>
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
              <Button
                type="button"
                variant="outline"
                className={isOwner ? undefined : "ml-auto shrink-0"}
                onClick={onAddToProjects}
                disabled={!canAddToProjects}
              >
                <UserPlus className="mr-1.5 size-4" />
                {t("org.membersPage.orgPage.addToProjectsButton")}
              </Button>
              {isOwner ? (
                <Button
                  className="ml-auto shrink-0"
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
                    <MenuItem onClick={() => openRoleChange(m)}>
                      <ShieldUser className="size-4" />
                      {t("org.membersPage.changeRoleAria")}
                    </MenuItem>
                    <MenuSeparator />
                  </>
                )}
                <DisabledFieldTooltip
                  disabled={!canRemove}
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

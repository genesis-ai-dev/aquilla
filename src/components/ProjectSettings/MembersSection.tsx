// Project settings — Members pane (DataTable roster).
//
// Lives at `/project/:id/settings/members`. Same grant/revoke contracts as the
// former `/project/:id/members` surface and MembersTab. Uses the shared
// DataTable (search + TanStack sort headers). "Add a member" opens a dialog
// with tabs: add people from the org, or create an invite link.

import { useCallback, useEffect, useMemo, useState } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import {
  AlertTriangle, Lock, MoreHorizontal, UserPlus,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { InitialsAvatar } from "@/components/InitialsAvatar"
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
import { useActiveOrgOptional } from "@/context/OrgContext"
import { listOrgMembers, type OrgMember } from "@/lib/frontier/orgs"
import { partitionMembers, type ProjectMember } from "@/lib/frontier/members"
import {
  ROLE, PROJECT_ROLE_OPTIONS, humanRoleName, roleDisplayText,
} from "@/lib/frontier/roles"
import { toUserFacingError } from "@/lib/errors/user-error"
import { cn } from "@/lib/utils"

const SOURCE_LABELS: Record<string, string> = {
  override: "direct invite",
  group: "via team",
  org: "via org",
  creator: "project creator",
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
        "rounded-full border-transparent font-normal",
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
  const { session } = useFrontierSession()
  const {
    members, isLoading, error, rosterHidden, refresh, add, addMany, remove,
  } = useProjectMembers(projectId)

  const callerMaxRole = ROLE.MAINTAINER
  const callerUsername = session?.username ?? null
  const hasJwt = Boolean(session?.jwt)

  const projectOrgId = useProjectOrgId(projectId)
  const activeOrgId = useActiveOrgOptional()?.activeOrgId ?? null
  const rosterOrgId = projectOrgId ?? activeOrgId

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
        header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
        meta: { className: "min-w-0 w-[50%]" },
        cell: ({ row }) => {
          const m = row.original
          return (
            <div className="flex min-w-0 items-center gap-2">
              <InitialsAvatar name={m.username} size="sm" singleInitial />
              <span className="truncate font-medium text-foreground">
                {m.username}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {SOURCE_LABELS[m.role.source] ?? m.role.source}
              </span>
            </div>
          )
        },
      },
      {
        id: "email",
        accessorFn: (m) => (m.email ?? "").toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Email" />,
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
        header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
        meta: { className: "w-0 whitespace-nowrap" },
        cell: ({ row }) => (
          <MemberRoleBadge name={row.original.role.name} level={row.original.role.level} />
        ),
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        meta: { align: "right" as const, className: "w-10" },
        cell: ({ row }) => {
          const m = row.original
          const isSelf = callerUsername !== null && m.username === callerUsername
          const isLocked = m.role.source === "org" || m.role.source === "creator"
          const canRemoveDirect =
            !isLocked && !isSelf && m.role.source === "override"
          const canChangeRole = !isLocked && !isSelf

          return (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="opacity-0 transition-none group-hover:bg-accent group-hover:opacity-100 group-hover:text-accent-foreground focus-visible:bg-accent focus-visible:opacity-100 data-popup-open:bg-accent data-popup-open:opacity-100 data-popup-open:text-accent-foreground"
                    aria-label={`Actions for ${m.username}`}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="min-w-44">
                {canChangeRole && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      Change role
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {grantableRoles.map((r) => (
                        <DropdownMenuItem
                          key={r.level}
                          onClick={() => void add(m.username, r.level)}
                        >
                          <RoleLabel name={r.name} />
                          {r.level === m.role.level ? " (current)" : ""}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {canRemoveDirect && (
                  <DropdownMenuItem onClick={() => setRemoveTarget(m)}>
                    Remove direct access
                  </DropdownMenuItem>
                )}
                {hasJwt && !isSelf && (
                  <>
                    {(canChangeRole || canRemoveDirect) && (
                      <DropdownMenuSeparator />
                    )}
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setRevokeTarget(m)}
                    >
                      Revoke all access…
                    </DropdownMenuItem>
                  </>
                )}
                {!canChangeRole && !canRemoveDirect && !(hasJwt && !isSelf) && (
                  <DropdownMenuItem disabled>
                    No actions available
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        },
      },
    ],
    [add, callerUsername, grantableRoles, hasJwt],
  )

  if (rosterHidden) {
    return (
      <div id="section-members" data-testid="settings-members-section">
        <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
          <Lock className="h-5 w-5" />
          <p className="text-sm font-medium text-foreground">Roster hidden</p>
          <p className="max-w-xs text-xs">
            This organization has restricted who can view the member list. Ask an owner or
            maintainer if you need access.
          </p>
        </div>
      </div>
    )
  }

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
              Retry
            </button>
          </div>
        )}

        {isLoading && members.length === 0 ? (
          <LoadingPanel label="Loading members" className="min-h-48" />
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
                    { value: "all", label: "All" },
                    { value: "project", label: "Project grants" },
                    { value: "org", label: "Via organization" },
                  ]}
                  value={accessFilter}
                  onValueChange={(v) => setAccessFilter((v as AccessFilter) ?? "all")}
                >
                  <SelectTrigger className="h-8 bg-card" aria-label="Filter members">
                    <SelectValue className="flex-none" />
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectGroup>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="project">Project grants</SelectItem>
                      <SelectItem value="org">Via organization</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  className="ml-auto shrink-0 gap-1.5"
                  onClick={openAddDialog}
                >
                  <UserPlus className="size-3.5" />
                  Add a member
                </Button>
              </>
            }
            rowClassName="group"
            emptyState={
              <p className="py-10 text-center text-sm text-muted-foreground">
                {members.length === 0
                  ? "No members yet. Add someone to grant project access."
                  : "No members match this filter."}
              </p>
            }
            testId="settings-members-table"
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
            <DialogTitle>Add a member</DialogTitle>
            <DialogDescription>
              Grant access from your organization, or create a shareable invite link.
            </DialogDescription>
          </DialogHeader>
          <Tabs
            value={addTab}
            onValueChange={(v) => setAddTab((v as AddDialogTab) ?? "members")}
            className="gap-3"
          >
            <TabsList size="lg" className="w-full" aria-label="Add member method">
              <TabsTrigger value="members">Add members</TabsTrigger>
              <TabsTrigger value="invite">Invite link</TabsTrigger>
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
                  action="add members to this project"
                  requiredRole="Maintainer or higher"
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
        title="Remove member"
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

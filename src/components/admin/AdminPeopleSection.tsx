import { useMemo } from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { AlertTriangle, Users } from "lucide-react"
import { toast } from "@/components/ui/toast"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { missingLast, SORT_MISSING_LAST } from "@/components/ui/data-table-missing"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { EmptyState } from "@/components/ui/empty"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { ADMIN_TABLE_PANEL_CLASS } from "@/components/admin/shared"
import type { AdminUser, AdminAdmin } from "@/lib/frontier/admin"

function CopyEmailButton({ email }: { email: string }) {
  return (
    <button
      type="button"
      className="max-w-full truncate text-left text-muted-foreground transition-colors hover:text-foreground"
      aria-label={`Copy ${email}`}
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

/**
 * People — the merge of the old Users and Admins tabs. Every registered user is
 * a row; allowlisted emails show as Role = Platform admin. Allowlisted emails
 * with no matching account are surfaced as a callout so the list stays auditable.
 */
export function AdminPeopleSection({ users, admins }: { users: AdminUser[]; admins: AdminAdmin[] }) {
  const adminEmails = useMemo(
    () => new Set(admins.map((a) => a.email.trim().toLowerCase())),
    [admins],
  )
  const orphanAdmins = useMemo(() => admins.filter((a) => !a.hasAccount), [admins])

  const columns = useMemo<ColumnDef<AdminUser>[]>(
    () => [
      {
        id: "user",
        accessorFn: (u) => (u.displayName ?? u.username).toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="User" />,
        cell: ({ row }) => {
          const u = row.original
          return (
            <UsernameWithAvatar
              username={u.username}
              label={u.displayName ? `${u.displayName} (${u.username})` : u.username}
              nameClassName="font-normal"
            />
          )
        },
      },
      {
        accessorKey: "email",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Email" />,
        cell: ({ row }) => <CopyEmailButton email={row.original.email} />,
      },
      {
        id: "role",
        accessorFn: (u) => (adminEmails.has(u.email.trim().toLowerCase()) ? 1 : 0),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
        cell: ({ row }) =>
          adminEmails.has(row.original.email.trim().toLowerCase()) ? (
            <span>Platform admin</span>
          ) : null,
      },
      {
        accessorKey: "orgCount",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Orgs" className="justify-end" />
        ),
        cell: ({ row }) => (
          <div className="text-right tabular-nums">{row.original.orgCount}</div>
        ),
      },
      {
        id: "lastActive",
        accessorFn: (u) => missingLast(u.lastActiveAt ? Date.parse(u.lastActiveAt) : undefined),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last active" />,
        cell: ({ row }) => (
          <DateTooltip value={row.original.lastActiveAt} label="Last active" />
        ),
      },
      {
        id: "joined",
        accessorFn: (u) => Date.parse(u.createdAt) || 0,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Joined" />,
        cell: ({ row }) => (
          <DateTooltip value={row.original.createdAt} label="Joined" />
        ),
      },
    ],
    [adminEmails],
  )

  if (users.length === 0) {
    return (
      <EmptyState
        variant="panel"
        icon={Users}
        title="No users yet"
        description="People appear here once they register."
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {orphanAdmins.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-50/60 px-4 py-3 text-sm dark:bg-amber-950/20">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">
              {orphanAdmins.length} allowlisted {orphanAdmins.length === 1 ? "email has" : "emails have"} no account
            </span>{" "}
            ({orphanAdmins.map((a) => a.email).join(", ")}) — a typo in{" "}
            <code className="text-xs">ADMIN_EMAILS</code>, or the person hasn't registered yet.
          </p>
        </div>
      )}

      <DataTable
        columns={columns}
        data={users}
        getRowId={(u) => String(u.id)}
        initialSorting={[{ id: "user", desc: false }]}
        searchPlaceholder="Search people…"
        globalFilterFn={(row, _columnId, filterValue) => {
          const q = String(filterValue).trim().toLowerCase()
          if (!q) return true
          const u = row.original
          const role = adminEmails.has(u.email.trim().toLowerCase()) ? "platform admin" : ""
          return `${u.username} ${u.displayName ?? ""} ${u.email} ${role}`.toLowerCase().includes(q)
        }}
        toolbar={(table) => (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {table.getFilteredRowModel().rows.length === users.length
              ? `${users.length}`
              : `${table.getFilteredRowModel().rows.length} of ${users.length}`}
          </span>
        )}
        testId="admin-people-table"
        className={ADMIN_TABLE_PANEL_CLASS}
        dense
      />
    </div>
  )
}

import { useMemo } from "react"
import { AlertTriangle, ShieldCheck, Users } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { AdminDataTable, type AdminColumn } from "./AdminDataTable"
import { fmtDate } from "@/lib/admin/format"
import type { AdminUser, AdminAdmin } from "@/lib/frontier/admin"

/**
 * People — the merge of the old Users and Admins tabs. Every registered user is
 * a row; the ones whose email is on the ADMIN_EMAILS allowlist wear a "Platform
 * admin" badge (the Admins tab was just this filtered view). Allowlisted emails
 * with no matching account are surfaced as a callout so the list stays auditable.
 */
export function AdminPeopleSection({ users, admins }: { users: AdminUser[]; admins: AdminAdmin[] }) {
  const adminEmails = useMemo(
    () => new Set(admins.map((a) => a.email.trim().toLowerCase())),
    [admins],
  )
  const orphanAdmins = useMemo(() => admins.filter((a) => !a.hasAccount), [admins])

  const columns: AdminColumn<AdminUser>[] = [
    {
      key: "user",
      header: "User",
      sortValue: (u) => (u.displayName ?? u.username).toLowerCase(),
      render: (u) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">
            {u.displayName ? `${u.displayName} (${u.username})` : u.username}
          </span>
          {adminEmails.has(u.email.trim().toLowerCase()) && (
            <Badge variant="secondary" className="gap-1 text-[11px]">
              <ShieldCheck className="size-3" /> Platform admin
            </Badge>
          )}
        </div>
      ),
    },
    { key: "email", header: "Email", sortValue: (u) => u.email.toLowerCase(), render: (u) => u.email },
    { key: "orgs", header: "Orgs", align: "right", sortValue: (u) => u.orgCount, render: (u) => u.orgCount },
    {
      key: "lastActive",
      header: "Last active",
      sortValue: (u) => (u.lastActiveAt ? Date.parse(u.lastActiveAt) : null),
      render: (u) => fmtDate(u.lastActiveAt),
    },
    {
      key: "joined",
      header: "Joined",
      sortValue: (u) => Date.parse(u.createdAt) || null,
      render: (u) => fmtDate(u.createdAt),
    },
  ]

  return (
    <div className="space-y-3">
      {orphanAdmins.length > 0 && (
        <div className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-50/60 px-4 py-3 text-sm dark:bg-amber-950/20">
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

      <AdminDataTable
        columns={columns}
        rows={users}
        getRowKey={(u) => u.id}
        searchText={(u) => `${u.username} ${u.displayName ?? ""} ${u.email}`}
        searchPlaceholder="Search people…"
        initialSort={{ key: "lastActive", dir: "desc" }}
        empty={{ icon: Users, title: "No users yet", description: "People appear here once they register." }}
        testId="admin-people-table"
      />
    </div>
  )
}

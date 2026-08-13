import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { ArrowRight, Building2, ShieldAlert } from "lucide-react"
import { Section, StatTile } from "@/components/ui/page"
import { EmptyState } from "@/components/ui/empty"
import { DataTable, DataTableColumnHeader } from "@/components/ui/data-table"
import { missingLast, SORT_MISSING_LAST } from "@/components/ui/data-table-missing"
import { ProjectStatus } from "@/components/ProjectStatus"
import { ValidatedBar } from "./ValidatedBar"
import { AdminActivityTimeline } from "./AdminActivityTimeline"
import {
  projectsNeedingAttention,
  mostActiveOrgs,
  recentSignupCount,
  validatedFraction,
  type RankedProject,
} from "@/lib/admin/insights"
import type { AdminOverview, AdminOrg, AdminUser, AdminProject, AdminActivity } from "@/lib/frontier/admin"
import { OrgWithAvatar } from "@/components/OrgWithAvatar"
import {
  ADMIN_TABLE_CLASS,
  ADMIN_TABLE_SECTION_CONTENT,
  ADMIN_TABLE_SECTION_HEADER,
} from "@/components/admin/shared"

/**
 * The Overview tab, rebuilt as an operator home. Stat tiles carry context via
 * `hint`; below them, three Sections answer "what needs me": at-risk projects,
 * the busiest tenants, and the latest activity. Every insight is derived
 * client-side from data the console already fetched — no new API calls.
 */
export function AdminOverviewHome({
  overview,
  orgs,
  users,
  projects,
  activity,
  onOpenOrg,
  onViewProjects,
  onViewActivity,
}: {
  overview: AdminOverview
  orgs: AdminOrg[]
  users: AdminUser[]
  projects: AdminProject[]
  activity: AdminActivity[]
  onOpenOrg: (orgId: number) => void
  onViewProjects: () => void
  onViewActivity: () => void
}) {
  const navigate = useNavigate()
  const [now] = useState(() => Date.now())
  const atRisk = useMemo(() => projectsNeedingAttention(projects, now, 6), [projects, now])
  const atRiskTotal = useMemo(() => projectsNeedingAttention(projects, now).length, [projects, now])
  const overdueCount = useMemo(
    () => projectsNeedingAttention(projects, now).filter((r) => r.reasons.some((x) => x.kind === "overdue")).length,
    [projects, now],
  )
  const newSignups = useMemo(() => recentSignupCount(users, now), [users, now])
  const topOrgs = useMemo(() => mostActiveOrgs(orgs, 5), [orgs])

  const atRiskColumns = useMemo<ColumnDef<RankedProject>[]>(
    () => [
      {
        id: "project",
        accessorFn: (r) => r.project.name.toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Project" />,
        cell: ({ row }) => (
          <span className="font-medium text-foreground">{row.original.project.name}</span>
        ),
      },
      {
        id: "org",
        accessorFn: (r) => missingLast((r.project.orgName ?? "").toLowerCase()),
        sortUndefined: SORT_MISSING_LAST,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Org" />,
        cell: ({ row }) =>
          row.original.project.orgName ? (
            <OrgWithAvatar
              name={row.original.project.orgName}
              size="xs"
              nameClassName="font-normal"
            />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "validated",
        accessorFn: (r) => validatedFraction(r.project),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Validated" />,
        cell: ({ row }) => <ValidatedBar fraction={validatedFraction(row.original.project)} />,
      },
      {
        id: "status",
        accessorFn: (r) => r.score,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) => (
          <ProjectStatus
            archived={false}
            reasons={row.original.reasons}
            deadlineAt={row.original.project.deadlineAt}
          />
        ),
      },
    ],
    [],
  )

  const orgColumns = useMemo<ColumnDef<AdminOrg>[]>(
    () => [
      {
        id: "organization",
        accessorFn: (o) => (o.name ?? `#${o.id}`).toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Organization" />,
        cell: ({ row }) => (
          <OrgWithAvatar name={row.original.name ?? `#${row.original.id}`} />
        ),
      },
      {
        accessorKey: "projectCount",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Projects" className="justify-end" />
        ),
        cell: ({ row }) => (
          <div className="text-right tabular-nums">{row.original.projectCount}</div>
        ),
      },
      {
        accessorKey: "memberCount",
        header: ({ column }) => (
          <DataTableColumnHeader column={column} title="Members" className="justify-end" />
        ),
        cell: ({ row }) => (
          <div className="text-right tabular-nums">{row.original.memberCount}</div>
        ),
      },
    ],
    [],
  )

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Organizations" value={overview.orgs} />
        <StatTile label="Teams" value={overview.teams} />
        <StatTile
          label="Users"
          value={overview.users}
          hint={newSignups > 0 ? `+${newSignups} in the last 7 days` : "No new signups this week"}
        />
        <StatTile
          label="Active projects"
          value={overview.activeProjects}
          hint={`${overview.archivedProjects.toLocaleString()} archived`}
        />
        <StatTile
          label="Active users"
          value={overview.activeUsers7d}
          hint={`of ${overview.users.toLocaleString()} · last 7 days`}
        />
        <StatTile
          label="Need attention"
          value={atRiskTotal}
          hint={overdueCount > 0 ? `${overdueCount} overdue` : "projects at risk"}
          className={atRiskTotal > 0 ? "border-amber-500/40" : undefined}
        />
      </div>

      <Section
        title="Needs attention"
        description="Active projects that are overdue, due soon, or stalled."
        headerClassName={ADMIN_TABLE_SECTION_HEADER}
        contentClassName={ADMIN_TABLE_SECTION_CONTENT}
        action={
          atRiskTotal > atRisk.length ? (
            <button
              type="button"
              onClick={onViewProjects}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              View all {atRiskTotal} <ArrowRight className="size-3" />
            </button>
          ) : null
        }
      >
        <DataTable
          columns={atRiskColumns}
          data={atRisk}
          getRowId={(r) => r.project.id}
          onRowClick={(r) => navigate(`/projects/${r.project.id}`)}
          initialSorting={[{ id: "status", desc: true }]}
          testId="admin-overview-attention-table"
          className={ADMIN_TABLE_CLASS}
          dense
          emptyState={
            <EmptyState
              variant="inline"
              className="py-6"
              icon={ShieldAlert}
              title="All clear"
              description="No active project is overdue, due soon, or stalled right now."
            />
          }
        />
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          title="Most active organizations"
          description="Busiest tenants by project count."
          headerClassName={ADMIN_TABLE_SECTION_HEADER}
          contentClassName={ADMIN_TABLE_SECTION_CONTENT}
        >
          <DataTable
            columns={orgColumns}
            data={topOrgs}
            getRowId={(o) => String(o.id)}
            onRowClick={(o) => onOpenOrg(o.id)}
            initialSorting={[{ id: "projectCount", desc: true }]}
            testId="admin-overview-orgs-table"
            className={ADMIN_TABLE_CLASS}
            dense
            emptyState={
              <EmptyState
                variant="inline"
                className="py-6"
                icon={Building2}
                title="No organizations yet"
              />
            }
          />
        </Section>

        <Section
          title="Latest activity"
          description="Recent cross-tenant events."
          action={
            <button
              type="button"
              onClick={onViewActivity}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              View all <ArrowRight className="size-3" />
            </button>
          }
        >
          <AdminActivityTimeline activity={activity} limit={6} now={now} />
        </Section>
      </div>
    </div>
  )
}

import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowRight, Building2, ShieldAlert } from "lucide-react"
import { Section, StatTile } from "@/components/ui/page"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { AttentionBadges, ValidatedBar } from "./shared"
import { AdminActivityTimeline } from "./AdminActivityTimeline"
import {
  projectsNeedingAttention,
  mostActiveOrgs,
  recentSignupCount,
  validatedFraction,
} from "@/lib/admin/insights"
import type { AdminOverview, AdminOrg, AdminUser, AdminProject, AdminActivity } from "@/lib/frontier/admin"

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
  const [now] = useState(() => Date.now())
  const atRisk = useMemo(() => projectsNeedingAttention(projects, now, 6), [projects, now])
  const atRiskTotal = useMemo(() => projectsNeedingAttention(projects, now).length, [projects, now])
  const overdueCount = useMemo(
    () => projectsNeedingAttention(projects, now).filter((r) => r.reasons.some((x) => x.kind === "overdue")).length,
    [projects, now],
  )
  const newSignups = useMemo(() => recentSignupCount(users, now), [users, now])
  const topOrgs = useMemo(() => mostActiveOrgs(orgs, 5), [orgs])

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
        {atRisk.length === 0 ? (
          <Empty className="border-0 bg-transparent py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShieldAlert />
              </EmptyMedia>
              <EmptyTitle>All clear</EmptyTitle>
              <EmptyDescription>
                No active project is overdue, due soon, or stalled right now.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="divide-y">
            {atRisk.map(({ project, reasons }) => (
              <li key={project.id} className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <Link to={`/projects/${project.id}`} className="font-medium text-primary hover:underline">
                    {project.name}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">{project.orgName ?? "—"}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <ValidatedBar fraction={validatedFraction(project)} />
                  <AttentionBadges reasons={reasons} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Most active organizations" description="Busiest tenants by project count.">
          {topOrgs.length === 0 ? (
            <Empty className="border-0 bg-transparent py-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Building2 />
                </EmptyMedia>
                <EmptyTitle>No organizations yet</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="divide-y">
              {topOrgs.map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                  <button
                    type="button"
                    onClick={() => onOpenOrg(o.id)}
                    className="min-w-0 truncate text-left text-sm font-medium text-foreground hover:text-primary hover:underline"
                  >
                    {o.name ?? `#${o.id}`}
                  </button>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {o.projectCount} {o.projectCount === 1 ? "project" : "projects"} · {o.memberCount}{" "}
                    {o.memberCount === 1 ? "member" : "members"}
                  </span>
                </li>
              ))}
            </ul>
          )}
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

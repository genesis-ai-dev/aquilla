// AQU-538 §3.3 — the per-project lane table shown on ProjectOverview directly
// under the header StatTiles, rendered ONLY when the project has more than one
// target-language lane (N=1 projects see no change). One row per lane:
//
//   Language | Translated % | Validated % | People | Last activity | Actions
//
// - Translated/Validated come from the project's PortfolioProject.lanes[]
//   (laneTranslatedPct / laneValidatedPct — §3.1 foundation, already in base).
// - People = lane-scoped members: sub-project_lead members whose
//   project_member_scopes carry a { kind:'lane', value:<tag> } row. Loaded the
//   same way SharePanel loads them (GET scopes per sub-500 member, tolerating
//   individual failures as "unscoped"). Leads (500+) are unscoped by design —
//   they see every lane and so are not attributed to any single row.
// - Actions per lane: Open (deep-links the workspace at that lane, §3.1),
//   Assign… (the existing AssignModal pinned to the lane via defaultLane, §3.5),
//   Staff… (the shared StaffLanePopover, §3.4).
// - "+ Add language" routes to the project's settings Languages section.

import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Languages, Plus } from "lucide-react"
import { projectSettingsPath } from "@/lib/navigation/org-paths"
import { Button, buttonVariants } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { StaffLanePopover } from "@/components/StaffLanePopover"
import { AssignModal } from "@/components/AssignModal"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { fetchMemberScopes, type MemberScope } from "@/lib/sync/member-scopes"
import { ROLE } from "@/lib/frontier/roles"
import { laneTranslatedPct, laneValidatedPct, type PortfolioLane } from "@/lib/frontier/portfolio"
import { formatRelativeTime } from "@/lib/time/relative"
import type { FileReference } from "@/lib/parsers/types"
import type { ProjectMember } from "@/lib/frontier/members"
import { useT } from "@/lib/i18n/I18nProvider"

export interface OverviewLaneTableProps {
  projectId: string
  /** Org that owns the project — for StaffLanePopover's roster + AssignModal. */
  orgId: number | null
  jwt: string | null
  /** Per-lane rollups (default '' lane first) from PortfolioProject.lanes. */
  lanes: PortfolioLane[]
  /** Human label for the default ('') lane — the project's targetLanguage. */
  defaultLanguageLabel: string
  /** Non-default lane registry (project.targetLanes) — AssignModal's lane select. */
  extraLanes: string[]
  /** All project files — AssignModal's book/file scope picker. */
  files: FileReference[]
  /** Caller's project role level — gates + passed to AssignModal. */
  roleLevel: number
  /** Author username stamped on assignment events. */
  author: string
  /** Whether the caller can assign/staff (project_lead 500+). */
  canManageLanes: boolean
  /** Whether the caller can add a language (maintainer 600+). */
  canAddLanguage: boolean
  /** Refresh the portfolio/workload after an assign or staff action. */
  onChanged?: () => void
  /** Injectable clock for deterministic relative-time tests. */
  now?: number
}

/** Stable id fragment for a lane's testids — '' (default lane) → 'default'. */
function laneTagId(lane: string): string {
  return lane === "" ? "default" : lane
}

/** People avatars for a lane, with an overflow "+N" bubble past the cap. */
function LanePeople({ members }: { members: ProjectMember[] }) {
  const CAP = 4
  if (members.length === 0) {
    return <span className="text-[11px] text-muted-foreground">—</span>
  }
  const shown = members.slice(0, CAP)
  const extra = members.length - shown.length
  return (
    <AvatarGroup data-size="sm">
      {shown.map((m) => (
        <AppTooltip key={m.userId} content={m.username}>
          <Avatar size="sm">
            <AvatarFallback>{m.username.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
        </AppTooltip>
      ))}
      {extra > 0 && <AvatarGroupCount>+{extra}</AvatarGroupCount>}
    </AvatarGroup>
  )
}

function LaneProgressBar({ pct, fillClass }: { pct: number; fillClass: string }) {
  const width = Math.round(pct * 100)
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <span className={`block h-full rounded-full ${fillClass}`} style={{ width: `${width}%` }} />
      </span>
      <span className="w-9 text-end text-xs tabular-nums text-muted-foreground">{width}%</span>
    </span>
  )
}

export function OverviewLaneTable({
  projectId,
  orgId,
  jwt,
  lanes,
  defaultLanguageLabel,
  extraLanes,
  files,
  roleLevel,
  author,
  canManageLanes,
  canAddLanguage,
  onChanged,
  now,
}: OverviewLaneTableProps) {
  const t = useT()
  const { members, refresh: refreshMembers } = useProjectMembers(projectId)
  const [scopesByUser, setScopesByUser] = useState<Record<number, MemberScope[]>>({})

  // AssignModal is a single instance driven by the lane row it was launched
  // from (defaultLane), matching the workspace's one-modal pattern.
  const [assignLane, setAssignLane] = useState<string | null>(null)

  // Scopable members = below project_lead (leads are unscoped, see every lane).
  const scopableUserIds = useMemo(
    () => members.filter((m) => m.role.level < ROLE.PROJECT_LEAD).map((m) => m.userId),
    [members],
  )

  // Load each scopable member's scopes exactly like SharePanel — tolerating an
  // individual failure as "unscoped" so one bad fetch never blanks the column.
  // (membersByLane filters against the live roster, so a stale scope for a
  // member who has left never leaks into a row.)
  useEffect(() => {
    if (!jwt || scopableUserIds.length === 0) return
    let alive = true
    void (async () => {
      const entries = await Promise.all(
        scopableUserIds.map(async (userId) => {
          const scopes = await fetchMemberScopes(jwt, projectId, userId)
          return [userId, scopes ?? []] as const
        }),
      )
      if (alive) setScopesByUser(Object.fromEntries(entries))
    })()
    return () => { alive = false }
  }, [jwt, projectId, scopableUserIds])

  // lane tag -> members scoped to that lane.
  const membersByLane = useMemo(() => {
    const map = new Map<string, ProjectMember[]>()
    for (const m of members) {
      for (const scope of scopesByUser[m.userId] ?? []) {
        if (scope.kind !== "lane") continue
        const list = map.get(scope.value) ?? []
        list.push(m)
        map.set(scope.value, list)
      }
    }
    return map
  }, [members, scopesByUser])

  const laneLabel = (lane: string) => (lane === "" ? defaultLanguageLabel : lane)

  return (
    <div className="rounded-xl border bg-card p-5" data-testid="overview-lane-table">
      <div className="mb-3 flex items-center gap-2">
        <Languages className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <h2 className="text-xs font-semibold text-muted-foreground">{t("fileDetails.languages")}</h2>
      </div>

      <div
        className="mb-1.5 flex items-center gap-3 text-xs font-medium text-muted-foreground"
        data-testid="overview-lane-header"
      >
        <span className="w-28 shrink-0">{t("org.orgHome.table.languageHeader")}</span>
        <span className="w-[104px] shrink-0">{t("org.orgHome.table.translatedHeaderLabel")}</span>
        <span className="w-[104px] shrink-0">{t("org.orgHome.table.validatedHeaderLabel")}</span>
        <span className="w-24 shrink-0">{t("org.overviewLaneTable.peopleColumn")}</span>
        <span className="flex-1">{t("org.overviewLaneTable.lastActivityColumn")}</span>
        <span className="shrink-0 text-end">{t("org.overviewLaneTable.actionsColumn")}</span>
      </div>

      <ul className="space-y-2" aria-label="Languages">
        {lanes.map((lane) => {
          const tagId = laneTagId(lane.lane)
          const label = laneLabel(lane.lane)
          const people = membersByLane.get(lane.lane) ?? []
          const rel = lane.lastEditAt != null
            ? formatRelativeTime(new Date(lane.lastEditAt).toISOString(), now)
            : null
          const openTo = lane.lane
            ? `/project/${projectId}/editor?lane=${encodeURIComponent(lane.lane)}`
            : `/project/${projectId}/editor`
          return (
            <li
              key={tagId}
              data-testid={`overview-lane-row-${tagId}`}
              className="flex flex-wrap items-center gap-3 text-sm"
            >
              <span className="w-28 shrink-0 font-medium">{label}</span>
              <span className="w-[104px] shrink-0">
                <LaneProgressBar pct={laneTranslatedPct(lane)} fillClass="bg-amber-500" />
              </span>
              <span className="w-[104px] shrink-0">
                <LaneProgressBar pct={laneValidatedPct(lane)} fillClass="bg-emerald-500" />
              </span>
              <span className="w-24 shrink-0">
                <LanePeople members={people} />
              </span>
              <span className="flex-1 text-xs text-muted-foreground">
                {rel ?? t("org.overviewLaneTable.noActivityYet")}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <Link
                  to={openTo}
                  data-testid={`overview-lane-open-${tagId}`}
                  className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
                >
                  {t("org.overviewLaneTable.openAction")}
                </Link>
                {canManageLanes && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid={`overview-lane-assign-${tagId}`}
                    onClick={() => setAssignLane(lane.lane)}
                  >
                    {t("org.assignWork.assignButtonLabel")}
                  </Button>
                )}
                {canManageLanes && (
                  <StaffLanePopover
                    projectId={projectId}
                    lane={lane.lane}
                    laneLabel={label}
                    orgId={orgId}
                    trigger={<span data-testid={`overview-lane-staff-${tagId}`}>{t("org.overviewLaneTable.staffAction")}</span>}
                    onDone={() => { void refreshMembers(); onChanged?.() }}
                  />
                )}
              </span>
            </li>
          )
        })}
      </ul>

      {canAddLanguage && (
        <div className="mt-3 border-t pt-3">
          <Link
            to={projectSettingsPath(projectId, "general")}
            data-testid="overview-lane-add-language"
            className={cn(
              buttonVariants({ size: "sm", variant: "ghost" }),
              "text-xs text-muted-foreground",
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("org.overviewLaneTable.addLanguageAction")}
          </Link>
        </div>
      )}

      {/* One shared AssignModal, pinned to the lane row it was launched from. */}
      <AssignModal
        open={assignLane != null}
        onOpenChange={(next) => { if (!next) setAssignLane(null) }}
        projectId={projectId}
        activeFileId={null}
        projectFiles={files}
        targetLanes={extraLanes}
        defaultLane={assignLane ?? ""}
        members={members}
        roleLevel={roleLevel}
        callerUserId={null}
        selectedCellIds={EMPTY_CELL_IDS}
        jwt={jwt ?? ""}
        author={author}
        onAssigned={() => { setAssignLane(null); onChanged?.() }}
      />
    </div>
  )
}

const EMPTY_CELL_IDS: ReadonlySet<string> = new Set()

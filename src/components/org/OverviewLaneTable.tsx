// AQU-538 §3.3 — the per-project lane table shown on ProjectOverview directly
// under the header StatTiles, rendered ONLY when the project has more than one
// target-language lane (N=1 projects see no change). One row per lane:
//
//   Language | Translated % | Validated % | People | Last activity | ⋯
//
// - Translated/Validated come from the project's PortfolioProject.lanes[]
//   (laneTranslatedPct / laneValidatedPct — §3.1 foundation, already in base).
// - People = lane-scoped members: sub-project_lead members whose
//   project_member_scopes carry a { kind:'lane', value:<tag> } row. Loaded the
//   same way SharePanel loads them (GET scopes per sub-500 member, tolerating
//   individual failures as "unscoped"). Leads (500+) are unscoped by design —
//   they see every lane and so are not attributed to any single row.
// - Actions live in the row ⋯ menu (and right-click): Open (deep-links the
//   workspace at that lane, §3.1), Assign… (AssignModal pinned via defaultLane,
//   §3.5), Staff… (StaffLanePopover, §3.4).
// - "+ Add language" routes to the project's settings Languages section.

import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { ExternalLink, UserPlus, Users } from "lucide-react"
import { projectSettingsPath } from "@/lib/navigation/org-paths"
import {
  ADMIN_TABLE_CLASS,
  ADMIN_TABLE_SECTION_CONTENT,
  ADMIN_TABLE_SECTION_HEADER,
} from "@/components/admin/shared"
import { Button } from "@/components/ui/button"
import {
  DataTable,
  DataTableColumnHeader,
  DataTableRowActionsButton,
} from "@/components/ui/data-table"
import { MenuItem, MenuSeparator } from "@/components/ui/menu-parts"
import { Section } from "@/components/ui/page"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { AppTooltip } from "@/components/ui/tooltip"
import { StaffLanePopover } from "@/components/StaffLanePopover"
import { AssignModal } from "@/components/AssignModal"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { fetchMemberScopes, type MemberScope } from "@/lib/sync/member-scopes"
import { ROLE } from "@/lib/frontier/roles"
import { laneTranslatedPct, laneValidatedPct, type PortfolioLane } from "@/lib/frontier/portfolio"
import { formatRelativeTime } from "@/lib/time/relative"
import type { FileReference } from "@/lib/parsers/types"
import type { ProjectMember } from "@/lib/frontier/members"

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

function laneOpenTo(projectId: string, lane: string): string {
  return lane
    ? `/project/${projectId}/editor?lane=${encodeURIComponent(lane)}`
    : `/project/${projectId}/editor`
}

/** People avatars for a lane, with an overflow "+N" bubble past the cap. */
function LanePeople({ members }: { members: ProjectMember[] }) {
  const CAP = 4
  if (members.length === 0) {
    return <span className="text-sm text-muted-foreground">—</span>
  }
  const shown = members.slice(0, CAP)
  const extra = members.length - shown.length
  return (
    <AvatarGroup data-size="sm">
      {shown.map((m) => (
        <AppTooltip key={m.userId} content={m.username}>
          <InitialsAvatar name={m.username} size="sm" singleInitial />
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
      <span className="w-9 text-right text-sm tabular-nums text-muted-foreground">{width}%</span>
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
  const navigate = useNavigate()
  const { members, refresh: refreshMembers } = useProjectMembers(projectId)
  const [scopesByUser, setScopesByUser] = useState<Record<number, MemberScope[]>>({})

  // AssignModal / StaffLanePopover are single instances driven by the lane row
  // they were launched from (⋯ menu), matching the workspace's one-modal pattern.
  const [assignLane, setAssignLane] = useState<string | null>(null)
  const [staffLane, setStaffLane] = useState<string | null>(null)

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

  const columns = useMemo<ColumnDef<PortfolioLane>[]>(
    () => [
      {
        id: "language",
        accessorFn: (l) => laneLabel(l.lane).toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Language" />,
        meta: { className: "min-w-[7rem]" },
        cell: ({ row }) => (
          <span className="text-sm font-medium text-foreground">{laneLabel(row.original.lane)}</span>
        ),
      },
      {
        id: "translated",
        accessorFn: (l) => laneTranslatedPct(l),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Translated" />,
        meta: { className: "w-[9rem]" },
        cell: ({ row }) => (
          <LaneProgressBar pct={laneTranslatedPct(row.original)} fillClass="bg-amber-500" />
        ),
      },
      {
        id: "validated",
        accessorFn: (l) => laneValidatedPct(l),
        header: ({ column }) => <DataTableColumnHeader column={column} title="Validated" />,
        meta: { className: "w-[9rem]" },
        cell: ({ row }) => (
          <LaneProgressBar pct={laneValidatedPct(row.original)} fillClass="bg-emerald-500" />
        ),
      },
      {
        id: "people",
        enableSorting: false,
        header: ({ column }) => <DataTableColumnHeader column={column} title="People" />,
        meta: { className: "w-[6.5rem]" },
        cell: ({ row }) => (
          <LanePeople members={membersByLane.get(row.original.lane) ?? []} />
        ),
      },
      {
        id: "activity",
        accessorFn: (l) => l.lastEditAt ?? 0,
        header: ({ column }) => <DataTableColumnHeader column={column} title="Last activity" />,
        meta: { className: "min-w-[7rem]" },
        cell: ({ row }) => {
          const at = row.original.lastEditAt
          const rel = at != null
            ? formatRelativeTime(new Date(at).toISOString(), now)
            : null
          return (
            <span className="text-sm text-muted-foreground">
              {rel ?? "No activity yet"}
            </span>
          )
        },
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        meta: { align: "right" as const, className: "w-10" },
        cell: ({ row }) => {
          const tagId = laneTagId(row.original.lane)
          const label = laneLabel(row.original.lane)
          return (
            <span className="inline-flex items-center justify-end gap-0.5">
              <DataTableRowActionsButton
                label={`Actions for ${label}`}
                data-testid={`overview-lane-actions-${tagId}`}
                revealOnHover
              />
              {/* Hidden anchor so Staff… from the ⋯ menu can open the popover
                  beside the actions cell without a second visible button. */}
              {canManageLanes && (
                <StaffLanePopover
                  projectId={projectId}
                  lane={row.original.lane}
                  laneLabel={label}
                  orgId={orgId}
                  anchorOnly
                  open={staffLane === row.original.lane}
                  onOpenChange={(next) => {
                    setStaffLane(next ? row.original.lane : null)
                  }}
                  trigger={
                    <span
                      data-testid={`overview-lane-staff-${tagId}`}
                      className="sr-only"
                    >
                      Staff {label}
                    </span>
                  }
                  onDone={() => { void refreshMembers(); onChanged?.() }}
                />
              )}
            </span>
          )
        },
      },
    ],
    [
      canManageLanes,
      defaultLanguageLabel,
      membersByLane,
      now,
      onChanged,
      orgId,
      projectId,
      refreshMembers,
      staffLane,
    ],
  )

  return (
    <Section
      data-testid="overview-lane-table"
      title="Languages"
      description="Progress, people, and actions for each target language on this project."
      headerClassName={ADMIN_TABLE_SECTION_HEADER}
      contentClassName={ADMIN_TABLE_SECTION_CONTENT}
      action={
        canAddLanguage ? (
          <Button
            variant="outline"
            size="sm"
            render={
              <Link
                to={projectSettingsPath(projectId, "general")}
                data-testid="overview-lane-add-language"
              />
            }
          >
            Add language
          </Button>
        ) : null
      }
    >
      <DataTable
        columns={columns}
        data={lanes}
        getRowId={(l) => laneTagId(l.lane)}
        getRowAttributes={(l) => ({
          "data-testid": `overview-lane-row-${laneTagId(l.lane)}`,
        })}
        dense
        className={ADMIN_TABLE_CLASS}
        initialSorting={[{ id: "language", desc: false }]}
        onRowClick={(l) => navigate(laneOpenTo(projectId, l.lane))}
        renderRowMenuItems={(l) => {
          const tagId = laneTagId(l.lane)
          const openTo = laneOpenTo(projectId, l.lane)
          return (
            <>
              <MenuItem
                render={<Link to={openTo} data-testid={`overview-lane-open-${tagId}`} />}
              >
                <ExternalLink className="size-4" />
                Open
              </MenuItem>
              {canManageLanes && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    data-testid={`overview-lane-assign-${tagId}`}
                    onClick={() => setAssignLane(l.lane)}
                  >
                    <Users className="size-4" />
                    Assign…
                  </MenuItem>
                  <MenuItem
                    data-testid={`overview-lane-staff-menu-${tagId}`}
                    onClick={() => setStaffLane(l.lane)}
                  >
                    <UserPlus className="size-4" />
                    Staff…
                  </MenuItem>
                </>
              )}
            </>
          )
        }}
      />

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
    </Section>
  )
}

const EMPTY_CELL_IDS: ReadonlySet<string> = new Set()

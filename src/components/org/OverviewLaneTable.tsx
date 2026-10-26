// AQU-538 §3.3 — the per-project lane table shown on ProjectOverview directly
// under the header StatTiles. A project with one active lane and nothing
// archived sees no change. Archived lanes (AQU-1458) are not rows in this
// table; they sit in a collapsed group under it. One row per active lane:
//
//   Language | Translated % | Text Validated % | Audio Validated % | People | Last activity | ⋯
//
// - Translated comes from the project's PortfolioProject.lanes[]
//   (laneStartedPct — §3.1 foundation, already in base).
// - AQU-2178: the validation figures are TWO columns, not one. The single
//   "Validated" column was each language's *done* share (laneValidatedPct),
//   which since AQU-2167 means validated text for a Text language, approved
//   recordings for an Audio one and both halves on one line for a Text and
//   audio one — under a header that never said which, so a PM could not read
//   how far a language's audio validation had got without switching the
//   Progress card's language filter one language at a time. Now Text Validated
//   is its validated text alone (laneTextValidatedPct) and Audio Validated its
//   approved recordings over its own audio total (laneAudioValidatedPct), the
//   same arithmetic the card's tiles do, so the two surfaces cannot disagree.
//   A language that delivers no text, and one that owes no audio, print "—"
//   under the column that does not apply rather than a misleading 0%; a project
//   where no language owes audio has no Audio Validated column at all.
// - People = lane-scoped members: members below maintainer whose
//   project_member_scopes carry a { kind:'lane', value:<tag> } row. Loaded
//   with one GET scopes per member below 600, tolerating individual failures
//   as "unscoped". Maintainers (600+) see every lane and can't be scoped, so
//   they are not attributed to any single row. A project lead (500) can be
//   limited to lanes since AQU-1813, so a lane-limited lead is listed here
//   too (AQU-2027).
// - Clicking a row opens the workspace at that lane (§3.1). Actions live in
//   the row ⋯ menu (and right-click): Assign… (AssignModal pinned via
//   defaultLane, §3.5), Staff… (StaffLanePopover, §3.4).
// - AQU-1998: the People cell is also a way IN to that popover — clicking the
//   avatars opens Staff… for the lane, where the people listed can be removed
//   from it. The scope reads behind the column are re-run after any staffing
//   change, so a removal leaves the column without a reload.
// - "+ Add language" routes to the project's settings Languages section.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { type ColumnDef } from "@tanstack/react-table"
import { ChevronRight, UserPlus, Users } from "lucide-react"
import { projectSettingsPath } from "@/lib/navigation/org-paths"
import {
  ADMIN_TABLE_CLASS,
  ADMIN_TABLE_SECTION_CONTENT,
  ADMIN_TABLE_SECTION_HEADER,
} from "@/components/admin/shared"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  DataTable,
  DataTableColumnHeader,
  DataTableRowActionsButton,
} from "@/components/ui/data-table"
import { MenuItem } from "@/components/ui/menu-parts"
import { Section } from "@/components/ui/page"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { UserChip } from "@/components/UserChip"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { StaffLanePopover } from "@/components/StaffLanePopover"
import { AssignModal } from "@/components/AssignModal"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { fetchMemberScopes, type MemberScope } from "@/lib/sync/member-scopes"
import { laneScopesAsTags } from "@/lib/lanes/scope-ids"
import { ROLE } from "@/lib/frontier/roles"
import {
  laneAudioValidatedPct,
  laneDeliversAudioOnly,
  laneOwesAudio,
  laneStartedPct,
  laneTextValidatedPct,
  laneValidatedPct,
  type PortfolioLane,
} from "@/lib/frontier/portfolio"
import type { FileReference } from "@/lib/parsers/types"
import type { ProjectMember } from "@/lib/frontier/members"
import type { AssignLaneOption, TeamLaneAttachment } from "@/lib/sync/assignment-lane"
import { useT } from "@/lib/i18n/I18nProvider"
import { progressPercentOfFraction } from "@/lib/progress/progress-percent"
import { textProgressSegments } from "@/lib/progress/progress-palette"
import { ProgressSplitBar } from "@/components/progress/ProgressSplitBar"

export interface OverviewLaneTableProps {
  projectId: string
  /** Display name for the staffing grant sentence. */
  projectName?: string | null
  /** Org that owns the project — for StaffLanePopover's roster + AssignModal. */
  orgId: number | null
  jwt: string | null
  /** Active per-lane rollups (default '' lane first) from PortfolioProject.lanes. */
  lanes: PortfolioLane[]
  /** Archived lanes, in portfolio order. Omitted or empty renders no group. */
  archivedLanes?: PortfolioLane[]
  /** Human label for the default ('') lane — the project's targetLanguage. */
  defaultLanguageLabel: string
  /** Non-default lane registry (project.targetLanes) — AssignModal's lane select. */
  extraLanes: string[]
  /** AQU-1977: the project's own languages, in order — what Assign offers. See AssignModal's `lanes`. */
  assignLanes?: readonly AssignLaneOption[]
  /**
   * AQU-1994: the lanes someone on the project is on. The row's Assign…
   * dialog offers the same narrowed list the Team card's panel does.
   */
  staffedLaneIds?: ReadonlySet<string> | readonly string[] | null
  /** AQU-2047: attached teams' lane checks. See AssignModal's `teamLanes`. */
  teamLanes?: readonly TeamLaneAttachment[] | null
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
}

/** Stable id fragment for a lane's testids — '' (default lane) → 'default'. */
function laneTagId(lane: string): string {
  return lane === "" ? "default" : lane
}

/** Staff opens one popover. Two rows can share a tag (`""`); the lane id cannot. */
function laneStaffKey(lane: PortfolioLane): string {
  return lane.laneId ?? laneTagId(lane.lane)
}

function laneOpenTo(projectId: string, lane: { lane: string; laneId?: string | null }): string {
  const key = lane.laneId || lane.lane
  if (!key) return `/project/${projectId}/editor?lane=`
  return `/project/${projectId}/editor?lane=${encodeURIComponent(key)}`
}

/**
 * People avatars for a lane, with an overflow "+N" bubble past the cap.
 *
 * AQU-1998: where the caller can staff the lane, the whole cell opens that
 * lane's Staff… popover — the one place that both adds someone to the lane and
 * takes them off it. The press is stopped here because lane rows navigate to
 * the workspace on click, the same guard the popover's own trigger applies.
 * Without `onOpenStaff` (a Contributor) it stays plain, unclickable avatars.
 */
function LanePeople({
  members,
  laneLabel,
  testId,
  onOpenStaff,
}: {
  members: ProjectMember[]
  laneLabel: string
  testId: string
  onOpenStaff?: () => void
}) {
  const t = useT()
  const CAP = 4
  const shown = members.slice(0, CAP)
  const extra = members.length - shown.length
  const avatars =
    members.length === 0 ? (
      <span className="text-sm text-muted-foreground">—</span>
    ) : (
      <AvatarGroup data-size="sm">
        {shown.map((m) => (
          <UserChip key={m.userId} userId={m.userId} username={m.username} size="sm" avatarOnly />
        ))}
        {extra > 0 && <AvatarGroupCount>+{extra}</AvatarGroupCount>}
      </AvatarGroup>
    )
  if (!onOpenStaff) return avatars
  return (
    <button
      type="button"
      data-testid={testId}
      className="-mx-1 flex items-center rounded px-1 py-0.5 hover:bg-muted"
      aria-label={t("org.overviewLaneTable.peopleCellAriaLabel", { lane: laneLabel })}
      onClick={(event) => {
        event.stopPropagation()
        onOpenStaff()
      }}
    >
      {avatars}
    </button>
  )
}

/**
 * AQU-2178: one percentage cell in the Languages table, or "—" when the
 * language owes nothing under that column — no text to validate, or no audio.
 * A dash rather than "0%", because 0% says the work is outstanding and these
 * languages have none.
 */
function LaneFigure({ pct, testId }: { pct: number | null; testId: string }) {
  return (
    <span className="text-sm tabular-nums text-muted-foreground" data-testid={testId}>
      {pct == null ? "—" : `${progressPercentOfFraction(pct)}%`}
    </span>
  )
}

/**
 * A lane's progress as ONE two-part bar (AQU-1764, Sam 2026-10-13): validated
 * in the dark blue, then translated but not validated in the light one,
 * ending at the translated figure printed beside it. This replaced a pair of
 * single bars, amber for translated and emerald for validated. The validated
 * figure is printed separately — under its own column heading in the table,
 * as "N% validated" on an archived row — so both percentages stay in view.
 * Lanes carry no AI-draft count, so there is no striped part.
 */
function LaneProgressBar({ lane, dimmed = false }: {
  lane: PortfolioLane
  /** An archived lane: the bar drawn back, as its fills were at 70% before. */
  dimmed?: boolean
}) {
  // AQU-1493: never 100 while a cell in the lane is outstanding.
  // Media redesign slice 1: by what the language delivers — an Audio language's
  // bar is its approved lines, then its recorded ones.
  const t = useT()
  const translated = progressPercentOfFraction(laneStartedPct(lane))
  const validated = progressPercentOfFraction(laneValidatedPct(lane))
  return (
    <span className="flex items-center gap-2">
      <ProgressSplitBar
        segments={textProgressSegments({ validated, translated, total: 100 })}
        height={6}
        className={dimmed ? "w-16 opacity-70" : "w-16"}
      />
      <span
        className="w-9 text-right text-sm tabular-nums text-muted-foreground"
        aria-label={
          laneDeliversAudioOnly(lane)
            ? t("org.orgHome.pctRecorded", { pct: translated })
            : t("org.orgHome.pctTranslated", { pct: translated })
        }
      >
        {translated}%
      </span>
    </span>
  )
}

export function OverviewLaneTable({
  projectId,
  projectName,
  orgId,
  jwt,
  lanes,
  archivedLanes = [],
  defaultLanguageLabel,
  extraLanes,
  assignLanes,
  staffedLaneIds,
  teamLanes,
  files,
  roleLevel,
  author,
  canManageLanes,
  canAddLanguage,
  onChanged,
}: OverviewLaneTableProps) {
  const t = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const { members, refresh: refreshMembers } = useProjectMembers(projectId)
  const [scopesByUser, setScopesByUser] = useState<Record<number, MemberScope[]>>({})

  // AssignModal / StaffLanePopover are single instances driven by the lane row
  // they were launched from (⋯ menu), matching the workspace's one-modal pattern.
  const [assignLane, setAssignLane] = useState<string | null>(null)
  const [staffLane, setStaffLane] = useState<string | null>(null)
  const [archivedOpen, setArchivedOpen] = useState(false)
  /**
   * AQU-1998: bumped after a staffing change so the per-member scope reads
   * below re-run. The roster itself doesn't change when someone is added to or
   * removed from a lane — only their scopes do — so refreshing the members
   * alone left this column showing the staffing as it was before the change.
   */
  const [scopesNonce, setScopesNonce] = useState(0)

  // Scopable members = below maintainer. Maintainers see every lane and the
  // server refuses to scope them; a project lead can be lane-limited
  // (AQU-1813), so leads are read too (AQU-2027).
  const scopableUserIds = useMemo(
    () => members.filter((m) => m.role.level < ROLE.MAINTAINER).map((m) => m.userId),
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
  }, [jwt, projectId, scopableUserIds, scopesNonce])

  // AQU-1607: a lane scope is a lane id; the rows below are keyed by lane
  // tag, so read the ids back as tags through the portfolio's own lane rows.
  const laneIdentities = useMemo(
    () =>
      [...lanes, ...(archivedLanes ?? [])]
        .filter((lane): lane is PortfolioLane & { laneId: string } => Boolean(lane.laneId))
        .map((lane) => ({ id: lane.laneId, name: "", legacyTag: lane.lane })),
    [lanes, archivedLanes],
  )

  // lane tag -> members scoped to that lane.
  const membersByLane = useMemo(() => {
    const map = new Map<string, ProjectMember[]>()
    for (const m of members) {
      for (const scope of laneScopesAsTags(scopesByUser[m.userId] ?? [], laneIdentities)) {
        if (scope.kind !== "lane") continue
        const list = map.get(scope.value) ?? []
        list.push(m)
        map.set(scope.value, list)
      }
    }
    return map
  }, [members, scopesByUser, laneIdentities])

  // Rows of the table: target languages only (a source lane rides along in the
  // portfolio for the language pair's label).
  const targetLanes = useMemo(() => lanes.filter((lane) => lane.role !== "source"), [lanes])

  // AQU-2178: a project where no language owes audio has nothing to put in an
  // Audio Validated column, so it does not get one — its only visible change
  // is the "Text Validated" heading. Read off the rows this table draws;
  // archived rows label their own figures and need no column.
  const showAudioValidated = useMemo(() => targetLanes.some(laneOwesAudio), [targetLanes])
  // AQU-2194: and the other way round. Now that a one-language project shows
  // this table too, an Audio language on its own would read "Translated 0%"
  // and "Text Validated —" for text it never delivers. With no language that
  // delivers text, those two columns are left out; the Audio Validated column
  // carries the row.
  const showText = useMemo(
    () => targetLanes.length === 0 || targetLanes.some((lane) => !laneDeliversAudioOnly(lane)),
    [targetLanes],
  )

  // Stable across renders so the column definitions below, which now name a
  // lane in the People cell's accessible name, don't rebuild on every render.
  const laneLabel = useCallback(
    (lane: PortfolioLane) =>
      lane.name?.trim() || (lane.lane === "" ? defaultLanguageLabel : lane.lane),
    [defaultLanguageLabel],
  )

  const columns = useMemo<ColumnDef<PortfolioLane>[]>(
    () => [
      {
        id: "language",
        accessorFn: (l) => laneLabel(l).toLowerCase(),
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.orgHome.table.languageHeader")} />,
        meta: { className: "min-w-[7rem]" },
        cell: ({ row }) => (
          <span className="text-sm font-medium text-foreground">{laneLabel(row.original)}</span>
        ),
      },
      ...(showText
        ? ([
          {
            id: "translated",
            accessorFn: (l) => laneStartedPct(l),
            header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.orgHome.table.translatedHeaderLabel")} />,
            meta: { className: "w-[9rem]" },
            cell: ({ row }) => <LaneProgressBar lane={row.original} />,
          },
          {
            id: "textValidated",
            // A language with nothing to validate sorts below every real figure
            // rather than alongside a genuine 0% (same for audio below).
            accessorFn: (l) => (laneDeliversAudioOnly(l) ? -1 : laneTextValidatedPct(l)),
            header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.orgHome.table.textValidatedHeaderLabel")} />,
            meta: { className: "w-[9rem]" },
            // The figure only, no bar of its own. The Translated column's bar draws
            // the dark part at the language's DONE share (AQU-1764,
            // `laneValidatedPct`), which is this figure for a Text language but the
            // both-approved share for a Text and audio one — so for that language
            // the bar matches neither of these two columns, by design.
            cell: ({ row }) => (
              <LaneFigure
                testId={`overview-lane-text-validated-${laneTagId(row.original.lane)}`}
                pct={laneDeliversAudioOnly(row.original) ? null : laneTextValidatedPct(row.original)}
              />
            ),
          },
          ] satisfies ColumnDef<PortfolioLane>[])
        : []),
      ...(showAudioValidated
        ? [{
            id: "audioValidated",
            accessorFn: (l: PortfolioLane) => (laneOwesAudio(l) ? laneAudioValidatedPct(l) : -1),
            header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.projectOverview.audioValidated")} />,
            meta: { className: "w-[9rem]" },
            cell: ({ row }: { row: { original: PortfolioLane } }) => (
              <LaneFigure
                testId={`overview-lane-audio-validated-${laneTagId(row.original.lane)}`}
                pct={laneOwesAudio(row.original) ? laneAudioValidatedPct(row.original) : null}
              />
            ),
          } satisfies ColumnDef<PortfolioLane>]
        : []),
      {
        id: "people",
        enableSorting: false,
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.overviewLaneTable.peopleColumn")} />,
        meta: { className: "w-[6.5rem]" },
        cell: ({ row }) => (
          <LanePeople
            members={membersByLane.get(row.original.lane) ?? []}
            laneLabel={laneLabel(row.original)}
            testId={`overview-lane-people-${laneTagId(row.original.lane)}`}
            onOpenStaff={
              canManageLanes ? () => setStaffLane(laneStaffKey(row.original)) : undefined
            }
          />
        ),
      },
      {
        id: "activity",
        accessorFn: (l) => l.lastEditAt ?? 0,
        header: ({ column }) => <DataTableColumnHeader column={column} title={t("org.overviewLaneTable.lastActivityColumn")} />,
        meta: { className: "min-w-[7rem]" },
        cell: ({ row }) => {
          const at = row.original.lastEditAt
          return at != null ? (
            <DateTooltip
              value={at}
              label={t("org.overviewLaneTable.lastActivityColumn")}
              className="text-sm text-muted-foreground"
            />
          ) : (
            <span className="text-sm text-muted-foreground">
              {t("org.overviewLaneTable.noActivityYet")}
            </span>
          )
        },
      },
      ...(canManageLanes
        ? [{
            id: "actions",
            enableSorting: false,
            header: () => <span className="sr-only">{t("org.overviewLaneTable.actionsColumn")}</span>,
            meta: { align: "right" as const, className: "w-10" },
            cell: ({ row }: { row: { original: PortfolioLane } }) => {
              const tagId = laneTagId(row.original.lane)
              const label = laneLabel(row.original)
              return (
                <span className="inline-flex items-center justify-end gap-0.5">
                  <DataTableRowActionsButton
                    label={t("org.rowActionsAriaLabel", { name: label })}
                    data-testid={`overview-lane-actions-${tagId}`}
                    revealOnHover
                  />
                  {/* Hidden anchor so Staff… from the ⋯ menu can open the popover
                      beside the actions cell without a second visible button. */}
                  <StaffLanePopover
                    projectId={projectId}
                    lane={row.original.lane}
                    laneId={row.original.laneId}
                    laneLabel={label}
                    projectName={projectName}
                    orgId={orgId}
                    anchorOnly
                    open={staffLane === laneStaffKey(row.original)}
                    onOpenChange={(next) => {
                      setStaffLane(next ? laneStaffKey(row.original) : null)
                    }}
                    trigger={
                      <span
                        data-testid={`overview-lane-staff-${tagId}`}
                        className="sr-only"
                      >
                        {t("org.staffLanePopover.staffLaneHeading", { lane: label })}
                      </span>
                    }
                    onDone={() => {
                      void refreshMembers()
                      setScopesNonce((n) => n + 1)
                      onChanged?.()
                    }}
                  />
                </span>
              )
            },
          } satisfies ColumnDef<PortfolioLane>]
        : []),
    ],
    [
      canManageLanes,
      membersByLane,
      laneLabel,
      showAudioValidated,
      showText,
      onChanged,
      orgId,
      projectId,
      projectName,
      refreshMembers,
      staffLane,
      t,
    ],
  )

  return (
    <Section
      data-testid="overview-lane-table"
      title={t("fileDetails.languages")}
      description={t("org.overviewLaneTable.sectionDescription")}
      headerClassName={ADMIN_TABLE_SECTION_HEADER}
      contentClassName={ADMIN_TABLE_SECTION_CONTENT}
      action={
        canAddLanguage ? (
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={
              <Link
                to={projectSettingsPath(projectId, "general")}
                state={{ backgroundLocation: location, projectSettingsModalDepth: 1 }}
                data-testid="overview-lane-add-language"
              />
            }
          >
            {t("org.overviewLaneTable.addLanguageAction")}
          </Button>
        ) : null
      }
    >
      <DataTable
        columns={columns}
        data={targetLanes}
        getRowId={(l) => l.laneId ?? laneTagId(l.lane)}
        getRowAttributes={(l) => ({
          "data-testid": `overview-lane-row-${laneTagId(l.lane)}`,
        })}
        dense
        className={ADMIN_TABLE_CLASS}
        initialSorting={[{ id: "language", desc: false }]}
        onRowClick={(l) => navigate(laneOpenTo(projectId, l))}
        rowLink={{ columnId: "language", to: (l) => laneOpenTo(projectId, l) }}
        renderRowMenuItems={canManageLanes ? (l) => {
          const tagId = laneTagId(l.lane)
          return (
            <>
              <MenuItem
                data-testid={`overview-lane-assign-${tagId}`}
                onClick={() => setAssignLane(l.lane)}
              >
                <Users className="size-4" />
                {t("org.assignWork.assignButtonLabel")}
              </MenuItem>
              <MenuItem
                data-testid={`overview-lane-staff-menu-${tagId}`}
                onClick={() => setStaffLane(laneStaffKey(l))}
              >
                <UserPlus className="size-4" />
                {t("org.overviewLaneTable.staffAction")}
              </MenuItem>
            </>
          )
        } : undefined}
      />

      {archivedLanes.length > 0 && (
        <Collapsible open={archivedOpen} onOpenChange={setArchivedOpen} className="mt-3">
          <CollapsibleTrigger className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
            <ChevronRight className={`size-4 transition-transform ${archivedOpen ? "rotate-90" : ""}`} />
            <span data-testid="overview-lane-archived-toggle">
              {t("org.overviewLaneTable.archivedGroup", { count: archivedLanes.length })}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-1 flex flex-col gap-1" data-testid="overview-lane-archived-list">
              {archivedLanes.map((lane) => {
                const label = laneLabel(lane)
                return (
                  <li
                    key={lane.laneId || lane.lane}
                    data-testid={`overview-lane-archived-row-${laneTagId(lane.lane)}`}
                    className="flex flex-wrap items-center gap-3 rounded px-2 py-1.5 text-muted-foreground"
                  >
                    <Link
                      to={laneOpenTo(projectId, lane)}
                      className="min-w-28 text-sm text-muted-foreground underline-offset-2 hover:underline"
                    >
                      {label}
                    </Link>
                    <Badge variant="outline">{t("org.overviewLaneTable.archivedBadge")}</Badge>
                    <LaneProgressBar lane={lane} dimmed />
                    {/* No column headings here, so each figure names itself, as
                        the org table's expanded lane rows do — and since
                        AQU-2178 that is one phrase per half the language owes:
                        its text where it delivers text, its audio where it owes
                        audio. An archived language that owes neither prints no
                        figure rather than a bare percentage of nothing. */}
                    {!laneDeliversAudioOnly(lane) && (
                      <span
                        className="text-sm tabular-nums text-muted-foreground"
                        data-testid={`overview-lane-archived-text-validated-${laneTagId(lane.lane)}`}
                      >
                        {t("org.overviewLaneTable.pctTextValidated", {
                          pct: progressPercentOfFraction(laneTextValidatedPct(lane)),
                        })}
                      </span>
                    )}
                    {laneOwesAudio(lane) && (
                      <span
                        className="text-sm tabular-nums text-muted-foreground"
                        data-testid={`overview-lane-archived-audio-validated-${laneTagId(lane.lane)}`}
                      >
                        {t("org.overviewLaneTable.pctAudioValidated", {
                          pct: progressPercentOfFraction(laneAudioValidatedPct(lane)),
                        })}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* One shared AssignModal, pinned to the lane row it was launched from. */}
      <AssignModal
        open={assignLane != null}
        onOpenChange={(next) => { if (!next) setAssignLane(null) }}
        projectId={projectId}
        activeFileId={null}
        projectFiles={files}
        targetLanes={extraLanes}
        lanes={assignLanes}
        staffedLaneIds={staffedLaneIds}
        teamLanes={teamLanes}
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

// AQU-538 §3.2 — expanded per-lane detail for an OrgHome project row.
//
// One sub-row per lane: lane label | translated % (bar) | validated % | last
// activity (short calendar date, datetime on hover) | actions. Actions:
//   Open   → the workspace at that lane (/project/:id/editor?lane=<tag>)
//   Assign → AssignModal pre-scoped to the lane (via OrgLaneAssignModal)
//   Staff  → StaffLanePopover (add-person-to-lane in one gesture)
//
// Rendered inside DataTable's `renderSubRow` slot, so the outer element is a
// TableRow whose single full-width cell hosts the lane grid.

import { Link } from "react-router-dom"
import { UserPlus } from "lucide-react"
import { TableCell, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { StaffLanePopover } from "@/components/StaffLanePopover"
import {
  laneTranslatedPct,
  laneValidatedPct,
  type PortfolioLane,
} from "@/lib/frontier/portfolio"
import { laneChipLabel, safePct } from "./project-lanes"
import { textProgressSegments } from "@/lib/progress/progress-palette"
import { ProgressSplitBar } from "@/components/progress/ProgressSplitBar"
import { useT } from "@/lib/i18n/I18nProvider"
import { DateTooltip } from "@/components/ui/date-tooltip"

export interface ProjectLaneSubRowsProps {
  projectId: string
  projectName?: string | null
  lanes: PortfolioLane[]
  defaultLaneLabel: string
  colSpan: number
  orgId: number | null
  /** Launch AssignModal pre-scoped to a lane. Omitted ⇒ no Assign action. */
  onAssign?: (lane: string) => void
  /** Refresh callback after a staffing change. */
  onStaffed?: () => void
}

function laneOpenTo(projectId: string, lane: { lane: string; laneId?: string | null }): string {
  const key = lane.laneId || lane.lane
  if (!key) return `/project/${projectId}/editor?lane=`
  return `/project/${projectId}/editor?lane=${encodeURIComponent(key)}`
}

export function ProjectLaneSubRows({
  projectId,
  projectName,
  lanes,
  defaultLaneLabel,
  colSpan,
  orgId,
  onAssign,
  onStaffed,
}: ProjectLaneSubRowsProps) {
  const t = useT()
  return (
    <TableRow
      data-testid={`project-lanes-subrow-${projectId}`}
      className="hover:bg-transparent"
    >
      <TableCell colSpan={colSpan} className="bg-muted/20 p-0">
        <div className="divide-y">
          {lanes.map((lane) => {
            const label = laneChipLabel(lane.lane, defaultLaneLabel, t("org.projectOverview.laneDefaultFallback"), lane.name)
            const tpct = safePct(laneTranslatedPct(lane))
            const vpct = safePct(laneValidatedPct(lane))
            const lastEdit = lane.lastEditAt
            return (
              <div
                key={lane.laneId || lane.lane || "__default__"}
                data-testid={`project-lane-row-${projectId}-${lane.lane}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm"
              >
                <span className="min-w-[6rem] font-medium">{label}</span>

                <span className="flex min-w-[9rem] flex-1 items-center gap-2">
                  {/* AQU-1764: the shared two-part bar — validated, then
                      translated but not validated — ending at the translated
                      figure beside it; the validated figure follows. */}
                  <ProgressSplitBar
                    segments={textProgressSegments({ validated: vpct, translated: tpct, total: 100 })}
                    height={6}
                    className="w-full max-w-[8rem]"
                  />
                  <span className="tabular-nums text-muted-foreground" aria-label={t("org.orgHome.pctTranslated", { pct: tpct })}>
                    {tpct}%
                  </span>
                </span>

                <span className="tabular-nums text-muted-foreground" aria-label={t("org.orgHome.pctValidated", { pct: vpct })}>
                  {t("org.orgHome.pctValidated", { pct: vpct })}
                </span>

                <span className="min-w-[6rem] text-xs text-muted-foreground">
                  {lastEdit != null
                    ? <DateTooltip value={lastEdit} label={t("org.overviewLaneTable.lastActivityColumn")} />
                    : t("org.projectLaneSubRows.noActivity")}
                </span>

                <span className="ms-auto flex items-center gap-1.5">
                  <Button
                    render={<Link to={laneOpenTo(projectId, lane)} />}
                    size="xs"
                    variant="outline"
                  >
                    {t("org.overviewLaneTable.openAction")}
                  </Button>
                  {onAssign && (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => onAssign(lane.lane)}
                    >
                      {t("org.assignWork.assignButtonLabel")}
                    </Button>
                  )}
                  <StaffLanePopover
                    projectId={projectId}
                    lane={lane.lane}
                    laneId={lane.laneId}
                    laneLabel={label}
                    projectName={projectName}
                    orgId={orgId}
                    onDone={onStaffed}
                    trigger={
                      <>
                        <UserPlus className="size-3.5" aria-hidden />
                        {t("org.overviewLaneTable.staffAction")}
                      </>
                    }
                  />
                </span>
              </div>
            )
          })}
        </div>
      </TableCell>
    </TableRow>
  )
}

// AQU-538 §3.2 — expanded per-lane detail for an OrgHome project row.
//
// One sub-row per lane: lane label | translated % (bar) | validated % | last
// activity (relative) | actions. Actions:
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
import { formatRelativeTime } from "@/lib/time/relative"
import { laneChipLabel, safePct } from "./project-lanes"

export interface ProjectLaneSubRowsProps {
  projectId: string
  lanes: PortfolioLane[]
  defaultLaneLabel: string
  colSpan: number
  orgId: number | null
  /** Launch AssignModal pre-scoped to a lane. Omitted ⇒ no Assign action. */
  onAssign?: (lane: string) => void
  /** Refresh callback after a staffing change. */
  onStaffed?: () => void
}

function laneOpenTo(projectId: string, lane: string): string {
  return lane
    ? `/project/${projectId}/editor?lane=${encodeURIComponent(lane)}`
    : `/project/${projectId}/editor`
}

export function ProjectLaneSubRows({
  projectId,
  lanes,
  defaultLaneLabel,
  colSpan,
  orgId,
  onAssign,
  onStaffed,
}: ProjectLaneSubRowsProps) {
  return (
    <TableRow
      data-testid={`project-lanes-subrow-${projectId}`}
      className="hover:bg-transparent"
    >
      <TableCell colSpan={colSpan} className="bg-muted/20 p-0">
        <div className="divide-y">
          {lanes.map((lane) => {
            const label = laneChipLabel(lane.lane, defaultLaneLabel)
            const tpct = safePct(laneTranslatedPct(lane))
            const vpct = safePct(laneValidatedPct(lane))
            const relative =
              lane.lastEditAt != null
                ? formatRelativeTime(new Date(lane.lastEditAt).toISOString())
                : null
            return (
              <div
                key={lane.lane || "__default__"}
                data-testid={`project-lane-row-${projectId}-${lane.lane}`}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm"
              >
                <span className="min-w-[6rem] font-medium">{label}</span>

                <span className="flex min-w-[9rem] flex-1 items-center gap-2">
                  <span className="h-1.5 w-full max-w-[8rem] overflow-hidden rounded-full bg-muted" aria-hidden>
                    <span className="block h-full rounded-full bg-primary" style={{ width: `${tpct}%` }} />
                  </span>
                  <span className="tabular-nums text-muted-foreground" aria-label={`${tpct}% translated`}>
                    {tpct}%
                  </span>
                </span>

                <span className="tabular-nums text-muted-foreground" aria-label={`${vpct}% validated`}>
                  {vpct}% validated
                </span>

                <span className="min-w-[6rem] text-xs text-muted-foreground">
                  {relative ?? "No activity"}
                </span>

                <span className="ml-auto flex items-center gap-1.5">
                  <Button
                    render={<Link to={laneOpenTo(projectId, lane.lane)} />}
                    size="xs"
                    variant="outline"
                  >
                    Open
                  </Button>
                  {onAssign && (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => onAssign(lane.lane)}
                    >
                      Assign…
                    </Button>
                  )}
                  <StaffLanePopover
                    projectId={projectId}
                    lane={lane.lane}
                    laneLabel={label}
                    orgId={orgId}
                    onDone={onStaffed}
                    trigger={
                      <>
                        <UserPlus className="size-3.5" aria-hidden />
                        Staff…
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

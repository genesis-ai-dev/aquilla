import { memo, useState } from "react"
import { AlertTriangle, HelpCircle, FolderOpen, Users } from "lucide-react"
import { useProjectsMembersMatrix } from "@/hooks/useProjectsMembersMatrix"
import { useOrg } from "@/hooks/useOrg"
import { ROLE } from "@/lib/frontier/roles"
import { RoleLabel } from "@/components/RoleLabel"
import { MembersMatrixCellEditor } from "./MembersMatrixCellEditor"
import { MemberAccessDrillDown } from "./MemberAccessDrillDown"
import { AccessModelLegend } from "./AccessModelLegend"
import {
  AppTooltip,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { EmptyState } from "@/components/ui/empty"
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { MatrixMember, MatrixCell } from "@/hooks/useProjectsMembersMatrix"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

/**
 * Members × projects scan view, with inline cell editing.
 *
 * Click any cell to open a popover:
 *   - Empty cell → role picker; selecting a role POSTs /members for that
 *     project. Adds the user as a project_external if they aren't an org
 *     member, or as an override on top of their org role if they are.
 *   - Override cell → role picker (changes the override) + Remove button.
 *   - Org-inherited cell → "Make exception" picker that creates an
 *     override that supersedes the org grant for this project only.
 *   - Creator / GitLab cell → read-only with explanation of where to
 *     actually edit it (those grants live elsewhere).
 *
 * Refresh after every successful mutation re-fetches the matrix so the
 * cell color and source label update to match the new state.
 *
 * The cell color encodes role tier so the eye can scan without reading text:
 *   - viewer (100)         → muted gray
 *   - commenter (200)      → blue
 *   - reviewer (300)       → indigo
 *   - contributor (400)    → green
 *   - project_lead (500)   → amber
 *   - maintainer (600)     → orange
 *   - owner (700)          → primary
 *   - empty                → no fill
 *
 * Concentration risk: if a project has exactly one Owner, the column header
 * gets a warning indicator. Tooltip surfaces the rationale ("sole Owner —
 * losing this person locks the project").
 */
interface SelectedMember { userId: number; username: string }

export function MembersMatrixView() {
  const { matrix, isLoading, error, refresh } = useProjectsMembersMatrix()
  const { state: orgState } = useOrg()
  const orgId = orgState.kind === "success" ? orgState.org.id : null
  const [selectedMember, setSelectedMember] = useState<SelectedMember | null>(null)
  const [legendOpen, setLegendOpen] = useState(false)

  if (isLoading && !matrix) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Spinner className="mr-2" />
        <span className="text-sm">Building portfolio matrix…</span>
      </div>
    )
  }

  if (error) {
    return (
      <p className="text-xs text-destructive">{error}</p>
    )
  }

  if (!matrix || matrix.members.length === 0 || matrix.projects.length === 0) {
    const noProjects = matrix?.projects.length === 0
    const Icon = noProjects ? FolderOpen : Users
    return (
      <EmptyState
        variant="inline"
        className="bg-muted/30 py-8"
        icon={Icon}
        title={noProjects ? "No projects yet" : "No members beyond yourself"}
        description={
          noProjects
            ? "Once you create or sync a project, this view will populate."
            : "Invite someone from the Roster tab to start."
        }
      />
    )
  }

  return (
    <div className="flex gap-0 overflow-hidden rounded-md border bg-background">
      <div className="flex-1 overflow-x-auto">
        {/* Access model legend — collapsible, rendered above the table */}
        <AccessModelLegend open={legendOpen} onToggle={() => setLegendOpen((v) => !v)} />
        <Table className="min-w-full">
          <TableHeader>
            <TableRow>
              <TableHead
                scope="col"
                className="sticky left-0 z-10 border-r bg-background"
              >
                <div className="flex items-center gap-1">
                  <span>Member</span>
                  {/* On-demand model explainer — opens a tooltip with the full explanation */}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className="inline-flex items-center text-muted-foreground hover:text-foreground focus-visible:outline-none"
                          aria-label="How access is resolved"
                        />
                      }
                    >
                      <HelpCircle aria-hidden />
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      className="max-w-xs leading-snug"
                    >
                      Every member's access is the highest role they hold across
                      up to four paths: a direct project grant, any group attached
                      to this project, their org-wide role, or creator status.
                      Adding a lower grant never reduces access — to fully remove
                      someone, all contributing paths must be cleared.
                    </TooltipContent>
                  </Tooltip>
                </div>
              </TableHead>
              {matrix.projects.map((p) => (
                <ProjectHeaderCell
                  key={p.id}
                  project={p}
                  ownerCount={matrix.ownerCountByProject.get(p.id) ?? 0}
                />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {matrix.members.map((m) => (
              <MatrixRow
                key={m.userId}
                member={m}
                projects={matrix.projects}
                memberCells={matrix.cells.get(m.userId)}
                onMutated={refresh}
                isSelected={selectedMember?.userId === m.userId}
                onSelectMember={setSelectedMember}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Per-member drill-down panel — shown when a member row is selected */}
      {selectedMember && orgId != null && (
        <div className="w-72 shrink-0 border-l">
          <MemberAccessDrillDown
            orgId={orgId}
            userId={selectedMember.userId}
            username={selectedMember.username}
            onClose={() => setSelectedMember(null)}
          />
        </div>
      )}
    </div>
  )
}

function ProjectHeaderCell({
  project,
  ownerCount,
}: {
  project: CloudProjectSummary
  ownerCount: number
}) {
  const concentrationRisk = ownerCount === 1
  return (
    <TableHead
      scope="col"
      className="border-l align-bottom"
      style={{ minWidth: "9rem", maxWidth: "14rem" }}
    >
      <div className="flex items-center gap-1">
        <AppTooltip content={project.name}>
          <span className="truncate">{project.name}</span>
        </AppTooltip>
        {concentrationRisk && (
          <AppTooltip content="Sole Owner: losing this person locks the project">
            <span className="inline-flex items-center text-amber-600 dark:text-amber-400">
              <AlertTriangle />
            </span>
          </AppTooltip>
        )}
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">
        {project.role?.name ? <RoleLabel name={project.role.name} /> : ""}
      </div>
    </TableHead>
  )
}

// memo: re-renders only when this member's own cell map or the project list
// changes. With N members × M projects, avoiding re-render of all N rows when
// only one cell mutates is the critical win.
const MatrixRow = memo(function MatrixRow({
  member,
  projects,
  memberCells,
  onMutated,
  isSelected,
  onSelectMember,
}: {
  member: MatrixMember
  projects: CloudProjectSummary[]
  memberCells: Map<string, MatrixCell> | undefined
  onMutated: () => Promise<void>
  isSelected: boolean
  onSelectMember: (m: { userId: number; username: string } | null) => void
}) {
  function handleMemberClick() {
    onSelectMember(isSelected ? null : { userId: member.userId, username: member.username })
  }

  return (
    <TableRow>
      <TableHead
        scope="row"
        className="sticky left-0 z-10 border-r bg-background font-normal"
      >
        <button
          onClick={handleMemberClick}
          className={[
            "-mx-1 rounded px-1 text-sm hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            isSelected ? "font-semibold text-primary" : "",
          ].join(" ")}
        >
          {member.username}
        </button>
        {member.isOrgInherited && (
          <AppTooltip content="Access on every project comes from org-wide role; no per-project overrides.">
            <span className="ml-1.5 align-middle rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
              org-wide
            </span>
          </AppTooltip>
        )}
      </TableHead>
      {projects.map((p) => {
        const cell = memberCells?.get(p.id)
        const palette = cell ? colorForRole(cell.role.level) : ""
        const { label: sourceHint, badge: sourceBadge } = cell
          ? sourceInfo(cell.role.source)
          : { label: "", badge: "" }
        return (
          <MembersMatrixCellEditor
            key={p.id}
            cell={cell}
            userId={member.userId}
            username={member.username}
            projectId={p.id}
            onMutated={onMutated}
            cellClassName={palette}
            sourceHint={sourceHint}
            sourceBadge={sourceBadge}
            secondarySources={cell?.secondarySources}
          />
        )
      })}
    </TableRow>
  )
})

/** Color tier for the cell. Designed to read at a glance without legend. */
function colorForRole(level: number): string {
  if (level >= ROLE.OWNER) return "bg-primary/15 text-primary"
  if (level >= ROLE.MAINTAINER) return "bg-orange-500/15 text-orange-700 dark:text-orange-300"
  if (level >= ROLE.PROJECT_LEAD) return "bg-amber-500/15 text-amber-700 dark:text-amber-300"
  if (level >= ROLE.CONTRIBUTOR) return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
  if (level >= ROLE.REVIEWER) return "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
  if (level >= ROLE.COMMENTER) return "bg-blue-500/15 text-blue-700 dark:text-blue-300"
  return "bg-muted/40 text-muted-foreground"
}

/**
 * Maps a raw source string to the canonical grant-path vocabulary.
 * Returns { label, badge } where label is the display name and badge
 * is the 1-char code used in the source-badge (D/G/O/C).
 */
export function sourceInfo(source: string): { label: string; badge: string } {
  switch (source) {
    case "override": return { label: "direct", badge: "D" }
    case "group":    return { label: "via group", badge: "G" }
    case "org":      return { label: "org-wide", badge: "O" }
    case "creator":  return { label: "creator", badge: "C" }
    default:         return { label: "", badge: "" }
  }
}

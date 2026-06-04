import { memo } from "react"
import { Loader2, AlertTriangle } from "lucide-react"
import { useProjectsMembersMatrix } from "@/hooks/useProjectsMembersMatrix"
import { ROLE } from "@/lib/frontier/roles"
import { MembersMatrixCellEditor } from "./MembersMatrixCellEditor"
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
export function MembersMatrixView() {
  const { matrix, isLoading, error, refresh } = useProjectsMembersMatrix()

  if (isLoading && !matrix) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
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
    return (
      <div className="rounded-md border bg-muted/30 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          {matrix?.projects.length === 0
            ? "No projects yet. Once you create or sync a project, this view will populate."
            : "No members beyond yourself. Invite someone from the Roster tab to start."}
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-md border bg-background overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-muted/40">
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-10 bg-muted/40 border-r px-3 py-2 text-left text-xs font-medium text-muted-foreground"
            >
              Member
            </th>
            {matrix.projects.map((p) => (
              <ProjectHeaderCell
                key={p.id}
                project={p}
                ownerCount={matrix.ownerCountByProject.get(p.id) ?? 0}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.members.map((m) => (
            <MatrixRow
              key={m.userId}
              member={m}
              projects={matrix.projects}
              memberCells={matrix.cells.get(m.userId)}
              onMutated={refresh}
            />
          ))}
        </tbody>
      </table>
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
    <th
      scope="col"
      className="px-2 py-2 text-left text-xs font-medium border-l align-bottom"
      style={{ minWidth: "9rem", maxWidth: "14rem" }}
    >
      <div className="flex items-center gap-1">
        <span
          className="truncate"
          title={project.name}
        >
          {project.name}
        </span>
        {concentrationRisk && (
          <span
            title="Sole Owner — losing this person locks the project"
            className="inline-flex items-center text-amber-600 dark:text-amber-400"
          >
            <AlertTriangle className="h-3 w-3" />
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground capitalize">
        {project.role?.name?.replace(/_/g, " ") ?? ""}
      </div>
    </th>
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
}: {
  member: MatrixMember
  projects: CloudProjectSummary[]
  memberCells: Map<string, MatrixCell> | undefined
  onMutated: () => Promise<void>
}) {
  return (
    <tr className="border-t hover:bg-muted/20">
      <th
        scope="row"
        className="sticky left-0 z-10 bg-background border-r px-3 py-1.5 text-left font-normal whitespace-nowrap"
      >
        <span className="text-sm">{member.username}</span>
        {member.isOrgInherited && (
          <span
            className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground align-middle"
            title="Access on every project comes from org-level role; no per-project overrides."
          >
            via org
          </span>
        )}
      </th>
      {projects.map((p) => {
        const cell = memberCells?.get(p.id)
        const palette = cell ? colorForRole(cell.role.level) : ""
        const sourceHint = cell ? sourceLabel(cell.role.source) : ""
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
          />
        )
      })}
    </tr>
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

function sourceLabel(source: string): string {
  switch (source) {
    case "override": return "direct"
    case "group": return "via group"
    case "creator": return "creator"
    case "org": return "via org"
    default: return ""
  }
}

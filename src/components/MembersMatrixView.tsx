import { Loader2, AlertTriangle } from "lucide-react"
import { useProjectsMembersMatrix } from "@/hooks/useProjectsMembersMatrix"
import { ROLE } from "@/lib/frontier/roles"
import type { MatrixCell, MatrixMember } from "@/hooks/useProjectsMembersMatrix"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

/**
 * Members × projects scan view. Read-only v1: shows the role at every
 * intersection so an operational PM can spot coverage gaps and concentration
 * risk in one glance. Editing happens via drill-in to existing surfaces
 * (project name → project SharePanel; member name → roster row's project
 * chips). That keeps the matrix tight and avoids re-implementing role-pick
 * logic inline.
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
  const { matrix, isLoading, error } = useProjectsMembersMatrix()

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
            <MatrixRow key={m.userId} member={m} matrix={matrix} />
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

function MatrixRow({ member, matrix }: { member: MatrixMember; matrix: ReturnType<typeof useProjectsMembersMatrix>["matrix"] }) {
  if (!matrix) return null
  const memberCells = matrix.cells.get(member.userId)
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
      {matrix.projects.map((p) => {
        const cell = memberCells?.get(p.id)
        return <Cell key={p.id} cell={cell} />
      })}
    </tr>
  )
}

function Cell({ cell }: { cell: MatrixCell | undefined }) {
  if (!cell) {
    return (
      <td
        className="px-2 py-1.5 border-l text-center text-muted-foreground"
        title="No access"
      >
        <span aria-hidden>—</span>
        <span className="sr-only">No access</span>
      </td>
    )
  }
  const palette = colorForRole(cell.role.level)
  const sourceHint = sourceLabel(cell.role.source)
  return (
    <td
      className={`px-2 py-1.5 border-l text-[11px] ${palette}`}
      title={`${cell.role.name}${sourceHint ? ` · ${sourceHint}` : ""}`}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="capitalize truncate">{cell.role.name.replace(/_/g, " ")}</span>
        {sourceHint && (
          <span className="text-[9px] opacity-75 shrink-0" aria-hidden>
            {sourceHint[0]}
          </span>
        )}
      </div>
    </td>
  )
}

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
    case "creator": return "creator"
    case "org": return "via org"
    case "gitlab": return "via gitlab"
    default: return ""
  }
}

/**
 * AccessModelLegend — collapsible legend explaining the four grant paths
 * and the max-wins effective-role rule.
 *
 * Shown below the matrix header on demand (controlled by MembersMatrixView).
 */

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

interface AccessModelLegendProps {
  /** When true the legend body is visible. */
  open: boolean
  onToggle: () => void
}

const GRANT_PATHS = [
  {
    badge: "D",
    label: "Direct",
    badgeClass: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    description:
      "A role granted explicitly to this person on this project only. The most specific path — adding or removing it affects only this project.",
  },
  {
    badge: "G",
    label: "Via group",
    badgeClass: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
    description:
      "A role inherited because a group this person belongs to has access to this project. Edit the group's membership to change or remove this grant.",
  },
  {
    badge: "O",
    label: "Org-wide",
    badgeClass: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    description:
      "A role that applies to every project in this org because of the person's org-level role. Change the org membership to affect all projects at once.",
  },
  {
    badge: "C",
    label: "Creator",
    badgeClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    description:
      "Owner role is permanent until project ownership is transferred. Manage in the project's Settings → Share.",
  },
] as const

export function AccessModelLegend({ open, onToggle }: AccessModelLegendProps) {
  return (
    <div className="border-b bg-muted/20 text-xs">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-start text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <span
          className={`inline-block transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          aria-hidden
        >
          ▶
        </span>
        <span>Access model legend</span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 px-3 pb-3 pt-1">
          {/* Grant-path table */}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-6">Badge</TableHead>
                <TableHead className="w-24">Grant path</TableHead>
                <TableHead>Meaning</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {GRANT_PATHS.map((p) => (
                <TableRow key={p.badge}>
                  <TableCell>
                    <span
                      className={`inline-flex size-4 items-center justify-center rounded text-[9px] font-bold ${p.badgeClass}`}
                    >
                      {p.badge}
                    </span>
                  </TableCell>
                  <TableCell className="font-medium">{p.label}</TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">
                    {p.description}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Max-wins rule */}
          <div className="flex flex-col gap-0.5 rounded-md border bg-background px-3 py-2">
            <p className="font-medium">Effective role = max-wins</p>
            <p className="text-muted-foreground">
              A person's effective role on a project is the highest role they hold
              across all contributing paths. Adding a lower grant never reduces
              access. To fully remove someone, all contributing grant paths must
              be cleared.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

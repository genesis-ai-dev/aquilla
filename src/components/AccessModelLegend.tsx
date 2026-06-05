/**
 * AccessModelLegend — collapsible legend explaining the four grant paths
 * and the max-wins effective-role rule.
 *
 * Shown below the matrix header on demand (controlled by MembersMatrixView).
 */

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
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-muted-foreground hover:text-foreground"
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
        <div className="px-3 pb-3 pt-1 space-y-3">
          {/* Grant-path table */}
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="border-b">
                <th className="pb-1 pr-3 text-left font-medium text-muted-foreground w-6">
                  Badge
                </th>
                <th className="pb-1 pr-3 text-left font-medium text-muted-foreground w-24">
                  Grant path
                </th>
                <th className="pb-1 text-left font-medium text-muted-foreground">
                  Meaning
                </th>
              </tr>
            </thead>
            <tbody>
              {GRANT_PATHS.map((p) => (
                <tr key={p.badge} className="border-b last:border-0">
                  <td className="py-1.5 pr-3">
                    <span
                      className={`inline-flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold ${p.badgeClass}`}
                    >
                      {p.badge}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 font-medium whitespace-nowrap">{p.label}</td>
                  <td className="py-1.5 text-muted-foreground">{p.description}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Max-wins rule */}
          <div className="rounded-md border bg-background px-3 py-2 space-y-0.5">
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

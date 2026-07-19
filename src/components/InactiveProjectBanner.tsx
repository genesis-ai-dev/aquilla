// AQU-214: Banner shown inside a frozen (inactive) project.
//
// Mounted by ProjectOverview (and via SWARM-TODO by ProjectWorkspace when
// is_active=false). Blocks the "feel of working" by surfacing a full-width
// reactivation prompt. The actual edit-blocking at the hook level is done by
// deriving isReadOnly from isFrozen in useProjectPermissions / useProject
// consumers; this banner is the visible affordance.

import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"

interface InactiveProjectBannerProps {
  /** Display name of the project. Used in the banner copy. */
  projectName: string
  /**
   * True when the caller has role >= project_lead (500) and thus has permission
   * to reactivate. When false, only the read-only message is shown (no button).
   */
  canReactivate: boolean
  /** Called when the user confirms they want to reactivate. */
  onReactivate: () => void
  /** True while the reactivation PATCH is in flight. */
  busy?: boolean
}

/**
 * Full-width banner for an inactive (frozen) project. Place this above the
 * project content so it's the first thing users see when opening a frozen project.
 *
 * ProjectWorkspace.tsx integration (SWARM-TODO — forbidden this wave):
 *
 *   SWARM-TODO(AQU-214): Mount InactiveProjectBanner in ProjectWorkspace.tsx.
 *   Suggested location: just below the workspace header, above the file tab strip.
 *   Suggested JSX (after importing InactiveProjectBanner and useProjectLifecycle):
 *
 *     const { isFrozen, toggle, busy: lifecycleBusy } = useProjectLifecycle(projectId, project, refresh)
 *     const canReactivate = (project?.syncRole?.level ?? 0) >= 500
 *     ...
 *     {isFrozen && (
 *       <InactiveProjectBanner
 *         projectName={project?.name ?? ""}
 *         canReactivate={canReactivate}
 *         onReactivate={() => toggle(jwt ?? "")}
 *         busy={lifecycleBusy}
 *       />
 *     )}
 *
 *   The banner must be inside the workspace layout but ABOVE EditorTable.
 *   Placing it as the first child of the flex-col wrapper works.
 */
export function InactiveProjectBanner({
  projectName,
  canReactivate,
  onReactivate,
  busy = false,
}: InactiveProjectBannerProps) {
  return (
    <div
      className="flex w-full items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700/60 dark:bg-amber-950/40"
      role="status"
      aria-label="This project is inactive"
      data-testid="inactive-project-banner"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <p className="flex-1 text-sm text-amber-900 dark:text-amber-200">
        <span className="font-semibold">{projectName}</span> is inactive — it cannot be edited
        until reactivated.
      </p>
      {canReactivate && (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 border-amber-400 text-amber-900 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-200 dark:hover:bg-amber-900/60"
          onClick={onReactivate}
          disabled={busy}
          data-testid="reactivate-button"
        >
          {busy ? "Reactivating…" : "Reactivate"}
        </Button>
      )}
    </div>
  )
}

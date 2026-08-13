// Phase 5 / AD-9. Small per-cell badge that renders iff the source has
// changed since the translator last committed this target cell.
//
// Two consumption modes:
//   1. Standalone — pass {cellId, projectId, fileId}; the component
//      internally calls `useStaleSourceCells` and renders nothing until
//      that resolves.
//   2. Parent-managed — pass {cellId, staleCellIds}; the parent already
//      has the membership set and just wants the badge styling. This is
//      the form `EditorTable` row rendering uses (one fetch per file,
//      used to decorate every row).
//
// AQU-477 (§6/§9.4): a SECOND, visually distinct tone for INHERITED
// staleness — an ancestor further up the link chain changed (or the
// immediate upstream's own translation is itself stale against its
// source), even though this project's direct pin comparison sees nothing
// new yet (the "dormant middle hop" case). Rendered violet/dotted,
// matching the existing term:* rule badge idiom (purple dotted — see
// violation-decoration-plugin.ts) rather than the amber solid direct-stale
// triangle, so the two are never confused at a glance. When BOTH direct and
// inherited apply to the same cell, direct (amber) takes rendering
// priority — it is the more actionable, immediate signal.

import { AlertTriangle, GitBranchPlus } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useStaleSourceCells } from "@/hooks/useStaleSourceCells"
import { useT } from "@/lib/i18n/I18nProvider"

interface BaseProps {
  cellId: string
  /** Optional override for the direct-stale tooltip body. Defaults to the
   *  AD-9 wording. */
  tooltipText?: string
  /** Optional override for the inherited-stale tooltip body (AQU-477).
   *  Defaults to the chain wording. */
  upstreamTooltipText?: string
  /** Tailwind size; default 12px (h-3 w-3) so it fits in a cell action rail. */
  iconClassName?: string
}

interface ManagedProps extends BaseProps {
  /** Membership set produced by `useStaleSourceCells`. The component
   *  reads `.has(cellId)`; no internal fetch. */
  staleCellIds: ReadonlySet<string>
  /** AQU-477: membership set of cells whose ANCESTRY is stale (inherited,
   *  §6). Optional — omit to render only the direct-stale tone (existing
   *  call sites keep working unchanged). */
  upstreamStaleCellIds?: ReadonlySet<string>
  projectId?: never
  fileId?: never
  getToken?: never
}

interface StandaloneProps extends BaseProps {
  staleCellIds?: never
  upstreamStaleCellIds?: never
  projectId: string
  fileId: string
  /** Sync-token fetcher; same shape as `useCells`. Without this, the
   *  hook errors and the indicator renders nothing. */
  getToken: (fileId: string) => Promise<string | null>
}

export type StaleSourceIndicatorProps = ManagedProps | StandaloneProps


export function StaleSourceIndicator(props: StaleSourceIndicatorProps) {
  if (isManaged(props)) {
    return (
      <StaleBadge
        direct={props.staleCellIds.has(props.cellId)}
        inherited={props.upstreamStaleCellIds?.has(props.cellId) ?? false}
        tooltipText={props.tooltipText}
        upstreamTooltipText={props.upstreamTooltipText}
        iconClassName={props.iconClassName}
      />
    )
  }
  // Standalone — fetch internally. The hook's `enabled` defaults to
  // true; consumers can swap to managed mode to avoid duplicate fetches
  // when several indicators render in the same file.
  return <StandaloneStaleSource {...props} />
}

function isManaged(
  p: StaleSourceIndicatorProps,
): p is ManagedProps {
  return "staleCellIds" in p && p.staleCellIds != null
}

function StandaloneStaleSource(props: StandaloneProps) {
  const { staleCellIds, upstreamStaleCellIds } = useStaleSourceCells({
    projectId: props.projectId,
    fileId: props.fileId,
    getToken: props.getToken,
  })
  return (
    <StaleBadge
      direct={staleCellIds.has(props.cellId)}
      inherited={upstreamStaleCellIds.has(props.cellId)}
      tooltipText={props.tooltipText}
      upstreamTooltipText={props.upstreamTooltipText}
      iconClassName={props.iconClassName}
    />
  )
}

function StaleBadge({
  direct,
  inherited,
  tooltipText,
  upstreamTooltipText,
  iconClassName,
}: {
  direct: boolean
  inherited: boolean
  tooltipText?: string
  upstreamTooltipText?: string
  iconClassName?: string
}) {
  const t = useT()
  if (!direct && !inherited) return null
  // Direct (amber) takes priority when both apply — it's the more
  // actionable signal (this project's own pin moved), and showing both
  // icons would clutter the cell action rail for no added clarity.
  if (direct) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="img"
              aria-label={t("editor.stale.directLabel")}
              className="inline-flex items-center text-amber-600 dark:text-amber-400"
              data-testid="stale-source-indicator"
            />
          }
        >
          <AlertTriangle className={iconClassName ?? "h-3 w-3"} />
        </TooltipTrigger>
        <TooltipContent side="top">
          {tooltipText ?? t("editor.stale.directTooltip")}
        </TooltipContent>
      </Tooltip>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={t("editor.stale.upstreamLabel")}
            className="inline-flex items-center rounded-sm border border-dotted border-violet-500 text-violet-600 dark:border-violet-400 dark:text-violet-400"
            data-testid="upstream-stale-source-indicator"
          />
        }
      >
        <GitBranchPlus className={iconClassName ?? "h-3 w-3"} />
      </TooltipTrigger>
      <TooltipContent side="top">
        {upstreamTooltipText ?? t("editor.stale.upstreamTooltip")}
      </TooltipContent>
    </Tooltip>
  )
}

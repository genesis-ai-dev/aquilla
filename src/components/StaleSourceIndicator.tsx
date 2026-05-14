// Phase 5 / AD-9. Small per-cell badge that renders iff the source has
// changed since the translator last committed this target cell.
//
// Two consumption modes:
//   1. Standalone — pass {cellId, projectId, fileId}; the component
//      internally calls `useStaleSourceCells` and renders nothing until
//      that resolves.
//   2. Parent-managed — pass {cellId, staleCellIds}; the parent already
//      has the membership set and just wants the badge styling. This is
//      the preferred form for `EditorTable` row rendering once 2c-β
//      lands (one fetch per file, used to decorate every row).
//
// IMPORTANT (Phase 5 scope): per the deliverables, this component is
// exported but NOT wired into `CellRow.tsx` / `EditorTable.tsx` yet.
// The 2c-β editor rewrite owns those files; a follow-up after that
// merges drops the badge into the cell-row status area.

import { AlertTriangle } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useStaleSourceCells } from "@/hooks/useStaleSourceCells"

interface BaseProps {
  cellId: string
  /** Optional override for the tooltip body. Defaults to the AD-9 wording. */
  tooltipText?: string
  /** Tailwind size; default 12px (h-3 w-3) so it fits in a cell action rail. */
  iconClassName?: string
}

interface ManagedProps extends BaseProps {
  /** Membership set produced by `useStaleSourceCells`. The component
   *  reads `.has(cellId)`; no internal fetch. */
  staleCellIds: ReadonlySet<string>
  projectId?: never
  fileId?: never
  getToken?: never
}

interface StandaloneProps extends BaseProps {
  staleCellIds?: never
  projectId: string
  fileId: string
  /** Sync-token fetcher; same shape as `useCells`. Without this, the
   *  hook errors and the indicator renders nothing. */
  getToken: (fileId: string) => Promise<string | null>
}

export type StaleSourceIndicatorProps = ManagedProps | StandaloneProps

const DEFAULT_TOOLTIP =
  "The source has changed since this translation was last revised."

export function StaleSourceIndicator(props: StaleSourceIndicatorProps) {
  if (isManaged(props)) {
    return (
      <StaleBadge
        visible={props.staleCellIds.has(props.cellId)}
        tooltipText={props.tooltipText}
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
  const { staleCellIds } = useStaleSourceCells({
    projectId: props.projectId,
    fileId: props.fileId,
    getToken: props.getToken,
  })
  return (
    <StaleBadge
      visible={staleCellIds.has(props.cellId)}
      tooltipText={props.tooltipText}
      iconClassName={props.iconClassName}
    />
  )
}

function StaleBadge({
  visible,
  tooltipText,
  iconClassName,
}: {
  visible: boolean
  tooltipText?: string
  iconClassName?: string
}) {
  if (!visible) return null
  return (
    <TooltipProvider delay={0}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="img"
              aria-label="Source changed since last revision"
              className="inline-flex items-center text-amber-600 dark:text-amber-400"
              data-testid="stale-source-indicator"
            />
          }
        >
          <AlertTriangle className={iconClassName ?? "h-3 w-3"} />
        </TooltipTrigger>
        <TooltipContent side="top">
          {tooltipText ?? DEFAULT_TOOLTIP}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

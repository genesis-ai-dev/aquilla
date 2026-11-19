import { useCallback, useState, useTransition } from "react"
import { useNavigate, type NavigateOptions } from "react-router-dom"

import { BlockingLoadingOverlay } from "@/components/ui/loading-overlay"
import { useT } from "@/lib/i18n/I18nProvider"

/**
 * Navigate into a lazy route while surfacing the load as an observable pending
 * state on the control that triggered it (AQU-737).
 *
 * The project workspace (`/project/:id`) is a lazy route, so a click has a real
 * async window — the chunk fetch, then the workspace's own data load — during
 * which a bare `navigate()` leaves the clicked control idle and re-clickable, so
 * the affordance reads as "nothing happened." Wrapping the navigation in a React
 * transition makes that suspension observable as `isPending`, which drives both
 * a spinner and the disabled state. The pending signal is real (tied to the
 * actual suspension), never a timer: it flips true on click and clears exactly
 * when the destination route commits — or when the transition is aborted /
 * superseded — so a control is never left spinning and never clears early.
 *
 * `pendingTo` records the destination currently in flight so a grid of controls
 * (e.g. project cards) can spin only the one that was clicked; `isOpening(to)`
 * tests a specific target.
 *
 * `overlay` is a viewport-wide input blocker to render alongside the surface's
 * normal content: while the open is pending it covers the whole display area
 * so no *other* control can be clicked mid-transition, and it disappears the
 * moment the transition commits or aborts.
 */
/**
 * Start fetching the workspace's code now. For an open that has to ask the
 * server something before it knows its URL (the plan's "first open cell"):
 * the two waits then overlap instead of running one after the other. The
 * route's own `lazy()` import resolves from the same module record.
 */
export function preloadWorkspace(): void {
  void import("@/components/ProjectWorkspace").catch(() => {
    // The route's own import reports a failed chunk; this is only a head start.
  })
}

export function useOpenWorkspace() {
  const t = useT()
  const navigate = useNavigate()
  const [isPending, startTransition] = useTransition()
  const [pendingTo, setPendingTo] = useState<string | null>(null)

  const open = useCallback(
    (to: string, options?: NavigateOptions) => {
      setPendingTo(to)
      startTransition(() => {
        navigate(to, options)
      })
    },
    [navigate],
  )

  const isOpening = useCallback(
    (to: string) => isPending && pendingTo === to,
    [isPending, pendingTo],
  )

  const overlay = isPending ? (
    <BlockingLoadingOverlay
      label={t("workspace.openWorkspace.openingProject")}
      data-testid="workspace-opening-overlay"
    />
  ) : null

  return { isPending, pendingTo, open, isOpening, overlay }
}

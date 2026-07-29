import { useCallback, useState, useTransition } from "react"
import { useNavigate, type NavigateOptions } from "react-router-dom"

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
 */
export function useOpenWorkspace() {
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

  return { isPending, pendingTo, open, isOpening }
}

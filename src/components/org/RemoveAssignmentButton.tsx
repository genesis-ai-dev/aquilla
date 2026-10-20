// AQU-1969 (Sam, 2026-10-19: "It should be more easy to unassign work"): the
// org Team workload's one-click × on every row that is one assignment — the
// project Team card's validation list and the plan's "Assigned to" list too.
// One click, no confirm: the row goes at once and stays gone, as on the org
// workload, and a refusal says why under the list.
import { useCallback, useState } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"

export function RemoveAssignmentButton({
  scope,
  username,
  removing,
  onRemove,
  size = "icon-sm",
  testId,
}: {
  /** What the assignment covers, for the button's spoken name. */
  scope: string
  username: string | null
  removing: boolean
  onRemove: () => void
  size?: "icon-sm" | "icon-xs"
  testId?: string
}) {
  const t = useT()
  return (
    <AppTooltip content={t("org.workloadRollup.removeTooltip")}>
      <Button
        type="button"
        variant="ghost"
        size={size}
        aria-label={t("org.workloadRollup.removeAriaLabel", {
          scope,
          user: username ?? t("common.userChip.anonymous"),
        })}
        disabled={removing}
        onClick={onRemove}
        data-testid={testId}
      >
        <X />
      </Button>
    </AppTooltip>
  )
}

/**
 * Removing rows one at a time: which one is on its way, the ones already gone
 * (hidden at once, before the list is read again), and the last refusal.
 */
export function useAssignmentRemoval(remove: (assignmentId: string) => Promise<void>) {
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const removeOne = useCallback(async (assignmentId: string) => {
    setError(null)
    setRemovingId(assignmentId)
    try {
      await remove(assignmentId)
      setRemovedIds((prev) => new Set(prev).add(assignmentId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRemovingId(null)
    }
  }, [remove])
  return { removingId, removedIds, error, removeOne }
}

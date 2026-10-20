// AQU-1969 (Sam, 2026-10-19: "It should be more easy to unassign work"): the
// org Team workload's × on every row that is one assignment — the project Team
// card's validation list and the plan's "Assigned to" list too. Two clicks, no
// dialog (Sam, 2026-10-20): the × turns into an "Are you sure?" button in
// place, and that removes it. Leaving it (focus elsewhere, Escape, or a few
// seconds untouched) turns it back into the ×. Removed, the row goes at once
// and stays gone; a refusal says why under the list.
import { useCallback, useEffect, useRef, useState } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"

/** How long "Are you sure?" waits for its click before turning back into the ×. */
export const CONFIRM_TIMEOUT_MS = 4000

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
  const [confirming, setConfirming] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const who = { scope, user: username ?? t("common.userChip.anonymous") }

  useEffect(() => {
    if (!confirming) return
    confirmRef.current?.focus()
    const timer = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [confirming])

  if (confirming) {
    return (
      <Button
        ref={confirmRef}
        type="button"
        variant="destructive"
        size="xs"
        className="shrink-0"
        aria-label={t("org.workloadRollup.removeConfirmAriaLabel", who)}
        disabled={removing}
        onClick={() => {
          setConfirming(false)
          onRemove()
        }}
        onBlur={() => setConfirming(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setConfirming(false)
        }}
        data-testid={testId ? `${testId}-confirm` : undefined}
      >
        {t("org.workloadRollup.removeConfirm")}
      </Button>
    )
  }

  return (
    <AppTooltip content={t("org.workloadRollup.removeTooltip")}>
      <Button
        type="button"
        variant="ghost"
        size={size}
        aria-label={t("org.workloadRollup.removeAriaLabel", who)}
        disabled={removing}
        onClick={() => setConfirming(true)}
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

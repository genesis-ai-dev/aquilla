// How many of a cut take's pieces are approved, read-only (decision 7, Sam
// 2026-10-22). Each piece takes its own vote on its own row, so the take on
// top of them, in the Recording tab and in the recorder's list, has no vote of
// its own and says this instead.

import { CheckCheck } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import type { AudioValidationTake } from "@/components/cell/AudioValidationControl"
import { piecesApproved } from "@/components/cell/audio-validation-state"

export function PiecesApproved({
  pieces,
  requirement,
  testId,
}: {
  /** The take's pieces as the validation control would draw them. */
  pieces: readonly AudioValidationTake[]
  /** The project's required number of approvals for audio. */
  requirement: number
  testId?: string
}) {
  const t = useT()
  const counted = piecesApproved(pieces, requirement)
  if (!counted) return null
  const all = counted.approved === counted.total
  return (
    <span
      data-testid={testId}
      data-all-approved={all ? "true" : "false"}
      // Gives way before the take's name does in a narrow row (the recorder),
      // with the whole sentence on hover.
      title={t("editor.recordingTab.piecesApproved", { approved: counted.approved, count: counted.total })}
      className={cn(
        "flex min-w-0 items-center gap-1 text-[11px]",
        all ? "text-green-600 dark:text-green-500" : "text-muted-foreground",
      )}
    >
      {all && <CheckCheck className="h-3 w-3 shrink-0" />}
      <span className="truncate">
        {t("editor.recordingTab.piecesApproved", { approved: counted.approved, count: counted.total })}
      </span>
    </span>
  )
}

// AQU-1510: "already holds this" — the warning the assign forms show when a
// new assignment covers lines its assignee already has. It warns and never
// blocks (Sam, Oct 21): overlap can be deliberate.

import { AlertTriangle } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import type { FileOverlap } from "@/hooks/useAssignmentOverlap"
import { assignmentScopeText } from "./assignment-landing"

/** Files named before the list is cut short. */
const NAMED_FILES = 3

/** What the assignee already holds, as a reader scans it: "MAT 21–28", or the stored label. */
function heldText(overlap: FileOverlap["overlap"]): string {
  if (overlap.chapters.length > 0) {
    return assignmentScopeText({ scopeKind: "chapters", scopeLabel: overlap.chapters.join(", ") })
  }
  return overlap.scopeLabels.join(" · ")
}

export function AssignmentOverlapNotice({
  overlaps,
  username,
  fileName,
}: {
  overlaps: readonly FileOverlap[]
  username: string
  fileName: (fileId: string) => string
}) {
  const t = useT()
  if (overlaps.length === 0 || !username) return null
  const text =
    overlaps.length === 1
      ? t("dialog.assign.overlap.oneFile", {
          username,
          held: heldText(overlaps[0].overlap),
          file: fileName(overlaps[0].fileId),
        })
      : t("dialog.assign.overlap.manyFiles", {
          username,
          files:
            overlaps.slice(0, NAMED_FILES).map((o) => fileName(o.fileId)).join(", ") +
            (overlaps.length > NAMED_FILES ? ", …" : ""),
        })
  return (
    <div
      role="status"
      data-testid="assignment-overlap"
      className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>{text}</p>
    </div>
  )
}

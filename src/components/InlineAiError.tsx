// AQU-891: the one way an AI failure (draft, paragraph draft, batch
// completion, back-translation, agent apply) is allowed to reach the user
// inline.
//
// Before this, these surfaces rendered the raw `Error.message` in destructive
// text — which meant an OpenRouter 413 dumped a JSON payload onto every cell
// in the paragraph. Now the row shows a short plain-language line plus an info
// button; the verbatim message lives one click away in the shared status
// popover, with a Copy button so it can be sent to support.

import { useMemo, type ReactElement } from "react"
import { Info } from "lucide-react"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { cn } from "@/lib/utils"
import { CellAiStatusPopover, type AiStatusAction } from "./CellAiStatusPopover"

interface Props {
  /** The raw error text. Never rendered directly — it is categorized first. */
  message: string | undefined
  /** Optional lead-in naming the operation, e.g. "Apply failed". Rendered
   *  before the friendly title so a card with several failure modes still says
   *  which one this is. */
  label?: string
  actions?: AiStatusAction[]
  onDismiss?: () => void
  className?: string
  /** Set false when an ancestor already carries role="alert", so screen
   *  readers don't announce the same failure twice. */
  announce?: boolean
}

/** Renders as a <span> (not <p>) so it can sit inside phrasing-content
 *  containers like MarkerContent as well as ordinary block layout. */
export function InlineAiError({
  message,
  label,
  actions,
  onDismiss,
  className,
  announce = true,
}: Props): ReactElement {
  const error = useMemo(() => categorizeAiError(message ?? ""), [message])

  // `body !== raw` means the categorizer judged the raw text unfit to show —
  // a provider payload, a stack, a wall of text — and wrote prose in its
  // place. Only then is there anything to hide behind the info button.
  // A message we authored ("Out of credits.") is already the right thing to
  // read, so it stays inline exactly as before and gets no extra affordance.
  const hasDetail = error.raw.length > 0 && error.body !== error.raw
  const summary = hasDetail ? error.title : error.body
  const line = label ? `${label}: ${summary}` : summary

  return (
    <span
      role={announce ? "alert" : undefined}
      className={cn("flex flex-wrap items-center gap-1 text-xs text-destructive", className)}
    >
      <span>{line}</span>
      {(hasDetail || (actions?.length ?? 0) > 0) && (
        <CellAiStatusPopover
          error={error}
          actions={actions ?? []}
          onDismiss={onDismiss}
          trigger={
            <button
              type="button"
              aria-label={`Show error details: ${line}`}
              className="inline-flex items-center rounded-full text-destructive/80 outline-hidden hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Info className="h-3 w-3" />
            </button>
          }
        />
      )}
    </span>
  )
}

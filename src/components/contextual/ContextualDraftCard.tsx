// A pending autopilot draft, rendered in the cell it belongs to.
//
// This is where a contextual run stops being a progress bar. The run stages
// verified translations server-side; this shows each one where the translator
// is already looking, with the only two answers that matter one click away.
//
// Two deliberate choices:
//
//   - Accepting routes through the caller's OWN commit path (`onAccept` →
//     `handleEditorCommit`), not through any autopilot-specific write. The
//     draft becomes an ordinary human edit, subject to the same role check,
//     focus-lock check, and outbox as anything typed by hand. The agent
//     proposes; only a person commits, and there is exactly one commit path.
//   - The server report is fire-and-forget. The user's decision already landed
//     locally; blocking the UI on a bookkeeping call would make a fast action
//     feel slow for no gain, and the next hydrate reconciles a lost report.

import { useState } from "react"
import { Check, Sparkles, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  resolveContextualDraft,
  useContextualDrafts,
} from "@/lib/contextual/drafts-store"
import { reviewContextualDraft } from "@/lib/contextual/transport"

interface ContextualDraftCardProps {
  cellId: string
  projectId: string
  /** False for roles below contributor — the draft still shows (seeing the
   *  work is useful) but cannot be accepted into the document. */
  editable: boolean
  /** Commit the accepted text through the row's normal editor commit path. */
  onAccept: (text: string) => void
  /** Text direction of the target column. */
  dir?: "ltr" | "rtl"
}

export function ContextualDraftCard({
  cellId,
  projectId,
  editable,
  onAccept,
  dir,
}: ContextualDraftCardProps) {
  const drafts = useContextualDrafts()
  const draft = drafts.get(cellId)
  const [resolving, setResolving] = useState(false)

  if (!draft) return null

  const decide = (action: "accepted" | "rejected") => {
    if (resolving) return
    setResolving(true)
    if (action === "accepted") onAccept(draft.text)
    // Clear optimistically: the decision is already made locally, and a draft
    // that lingers after the click reads as a broken button.
    resolveContextualDraft(cellId, action)
    void reviewContextualDraft(
      projectId,
      draft.draftId,
      action === "accepted" ? "applied" : "rejected",
    ).catch((err: unknown) => {
      // Bookkeeping only — the edit itself already landed through the outbox.
      console.warn("[autopilot] draft review report failed:", err)
    })
  }

  return (
    <div
      data-testid="contextual-draft-card"
      data-cell-id={cellId}
      className={cn(
        "group/draft absolute inset-0 flex flex-col gap-1 rounded-md px-2 py-1",
        "border border-dashed border-primary/40 bg-primary/[0.04]",
        // Newly arrived drafts fade in so a wave landing reads as motion
        // rather than as text that was always there.
        "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300",
      )}
    >
      <p
        className="whitespace-pre-wrap leading-relaxed text-foreground/90"
        dir={dir}
        data-testid="contextual-draft-text"
      >
        {draft.text}
      </p>
      <div className="mt-auto flex items-center gap-1">
        <AppTooltip content={draft.spanLabel ? `Drafted from ${draft.spanLabel}` : "Drafted for you"}>
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Sparkles className="h-3 w-3" aria-hidden />
            Suggested
          </span>
        </AppTooltip>
        <div className="ml-auto flex items-center gap-0.5">
          {editable && (
            <AppTooltip content="Use this translation">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Use this translation"
                disabled={resolving}
                onClick={() => decide("accepted")}
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
            </AppTooltip>
          )}
          <AppTooltip content="Dismiss this suggestion">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Dismiss this suggestion"
              disabled={resolving}
              onClick={() => decide("rejected")}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </AppTooltip>
        </div>
      </div>
    </div>
  )
}

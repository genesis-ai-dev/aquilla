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
//   - Acceptance is projection-authoritative. A successful `onAccept` means
//     the target commit is durably queued in the local outbox, not that it won
//     server arbitration. The winning target projection applies/supersedes the
//     draft atomically and its event echo refreshes this mirror. Rejection has
//     no cell event, so it remains an explicit server-backed review action.

import { useState } from "react"
import { Check, Sparkles, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  resolveContextualDraft,
  useContextualDrafts,
  useContextualDraftsSummary,
} from "@/lib/contextual/drafts-store"
import { reviewContextualDraft } from "@/lib/contextual/transport"
import { useT } from "@/lib/i18n/I18nProvider"

interface ContextualDraftCardProps {
  cellId: string
  projectId: string
  fileId: string
  /** Empty string is Project default. Autopilot proposes into the open lane. */
  targetLang: string
  /** False for roles below contributor — evidence remains visible, but no
   *  commit or review action is offered. */
  editable: boolean
  /** Commit through the normal editor path and confirm durable enqueue. */
  onAccept: (text: string) => boolean | Promise<boolean>
  /** Text direction of the target column. */
  dir?: "ltr" | "rtl"
}

export function ContextualDraftCard({
  cellId,
  projectId,
  fileId,
  targetLang,
  editable,
  onAccept,
  dir,
}: ContextualDraftCardProps) {
  const t = useT()
  const drafts = useContextualDrafts()
  const summary = useContextualDraftsSummary()
  const draft =
    summary.projectId === projectId &&
    summary.fileId === fileId &&
    summary.targetLang === targetLang
      ? drafts.get(cellId)
      : undefined
  const [resolving, setResolving] = useState(false)
  const [decisionErrorDraftId, setDecisionErrorDraftId] = useState<string | null>(null)

  if (!draft) return null

  const decide = async (action: "accepted" | "rejected") => {
    if (resolving) return
    const decidedDraft = draft
    setResolving(true)
    setDecisionErrorDraftId(null)
    if (action === "accepted") {
      try {
        // This confirms only the durable local enqueue. Do not report
        // `applied` here: AD-2 arbitration still decides whether this commit
        // becomes the server cell head. The winning projection reconciles the
        // draft and its event.applied echo hydrates that authoritative result.
        if (await onAccept(decidedDraft.text) !== true) {
          setResolving(false)
          return
        }
      } catch {
        setResolving(false)
        return
      }
      setResolving(false)
      return
    }
    try {
      await reviewContextualDraft(
        projectId,
        decidedDraft.draftId,
        "rejected",
      )
    } catch {
      setDecisionErrorDraftId(decidedDraft.draftId)
      setResolving(false)
      return
    }

    // Identity-aware resolution cannot remove a replacement that arrived
    // while the durable content/review handshakes were in flight.
    const resolvedLocally = resolveContextualDraft(
      projectId,
      fileId,
      targetLang,
      cellId,
      decidedDraft.draftId,
      action,
    )
    if (!resolvedLocally) setResolving(false)
  }

  return (
    <div
      data-testid="contextual-draft-card"
      data-cell-id={cellId}
      // In normal flow, not absolute: the target cell is only min-h-[40px] when
      // empty, and an overlay would clip the text plus its actions. Letting the
      // cell grow around the card is what makes a long verse readable.
      //
      // Clicks stop here. The cell wrapper opens the editor on click, and
      // "accept" that also drops a caret into the cell it just filled is a
      // fight between two intents.
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "group/draft mt-1 flex flex-col gap-1 rounded-md px-2 py-1",
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
      <div className="flex items-center gap-1">
        <AppTooltip content={draft.spanLabel
          ? t("autopilot.draft.draftedFrom", { spanLabel: draft.spanLabel })
          : t("autopilot.draft.draftedForYou")}>
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Sparkles className="h-3 w-3" aria-hidden />
            {t("autopilot.draft.suggested")}
          </span>
        </AppTooltip>
        <div className="ms-auto flex items-center gap-0.5">
          {editable && (
            <AppTooltip content={t("autopilot.draft.useTranslation")}>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("autopilot.draft.useTranslation")}
                disabled={resolving}
                onClick={() => void decide("accepted")}
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
            </AppTooltip>
          )}
          {editable && (
            <AppTooltip content={t("autopilot.draft.dismissSuggestion")}>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("autopilot.draft.dismissSuggestion")}
                disabled={resolving}
                onClick={() => void decide("rejected")}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </AppTooltip>
          )}
        </div>
      </div>
      {decisionErrorDraftId === draft.draftId && (
        <p role="alert" className="text-xs text-destructive">
          {t("autopilot.draft.dismissFailed")}
        </p>
      )}
    </div>
  )
}

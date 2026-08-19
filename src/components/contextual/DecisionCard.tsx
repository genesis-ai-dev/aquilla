// One decision the agent could not settle alone (seam design §4.3).
//
// The card states WHY it exists and how far the answer reaches — "Two prior
// renderings of this name conflict" plus a blast-radius count, never a bare
// "review this". That is what turns an interruption into an answerable
// question instead of make-work. Dismiss sits beside Answer as a first-class
// action on purpose: dismissal rate is a designed quality signal (§4.2), so
// hiding or de-emphasising the dismiss path would corrupt the number that
// tells us the agent is generating noise.

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  actOnContextualDecision,
  type ContextualDecisionView,
} from "@/lib/contextual/transport"

export interface DecisionCardProps {
  decision: ContextualDecisionView
  projectId: string
  onResolved: () => void
}

export function DecisionCard({ decision, projectId, onResolved }: DecisionCardProps) {
  const t = useT()
  const [answer, setAnswer] = useState("")
  const [busy, setBusy] = useState(false)
  const [actionFailed, setActionFailed] = useState(false)

  async function act(action: "answer" | "dismiss", payload: Record<string, unknown>) {
    if (busy) return
    setBusy(true)
    setActionFailed(false)
    try {
      await actOnContextualDecision(projectId, decision.id, action, payload)
      onResolved()
    } catch {
      // A silent failure here reads as "your answer was recorded" when it
      // wasn't — the one thing this card must never do. Surface it and leave
      // the card interactive so the user can retry immediately.
      setActionFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-testid="contextual-decision-card"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <p className="text-sm">{decision.reason}</p>
      {decision.blastRadius > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("autopilot.decisions.blastRadius", { count: decision.blastRadius })}
        </p>
      )}
      <Textarea
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder={t("autopilot.decisions.answerPlaceholder")}
        rows={2}
      />
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || !answer.trim()}
          onClick={() => {
            const trimmed = answer.trim()
            if (!trimmed) return
            void act("answer", { answer: trimmed })
          }}
        >
          {t("autopilot.decisions.answer")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void act("dismiss", {})}
        >
          {t("autopilot.decisions.dismiss")}
        </Button>
      </div>
      {actionFailed && (
        <p role="alert" className="text-xs text-destructive">
          {t("autopilot.decisions.actionFailed")}
        </p>
      )}
    </div>
  )
}

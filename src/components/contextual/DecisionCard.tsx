// One decision the agent could not settle alone (seam design §4.3).
//
// The card states WHY it exists and how far the answer reaches — "Two prior
// renderings of this name conflict" plus a blast-radius count, never a bare
// "review this". That is what turns an interruption into an answerable
// question instead of make-work. Dismiss sits beside Answer as a first-class
// action on purpose: dismissal rate is a designed quality signal (§4.2), so
// hiding or de-emphasising the dismiss path would corrupt the number that
// tells us the agent is generating noise.
//
// AQU-1691: a fact question (`factKey`) keeps its answer as a project
// decision, so the card says so, offers the question's options as one-click
// answers, and explains a refused answer by its reason code. Most fact
// questions belong to no file, so they have no "where" line.

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import {
  actOnContextualDecision,
  ContextualApiError,
  type ContextualDecisionView,
} from "@/lib/contextual/transport"
import { profileSlotOfFactKey, type FactAnswerRejection } from "../../../db/shared/project-facts"
import { DecisionContext } from "./DecisionContext"

export interface DecisionCardProps {
  decision: ContextualDecisionView
  projectId: string
  onResolved: () => void
}

/** Why the server refused an answer (db/shared/project-facts.ts), as the card says it. */
const REJECTION_KEYS: Readonly<Partial<Record<FactAnswerRejection, MessageKey>>> = {
  "answer-too-long": "projectDecisions.card.reason.tooLong",
  "too-many-facts": "projectDecisions.card.reason.full",
  "profile-key-too-deep": "projectDecisions.card.reason.notStorable",
  "profile-slot-not-an-object": "projectDecisions.card.reason.notStorable",
  "profile-value-invalid": "projectDecisions.card.reason.notStorable",
}

/** The policy slots' values in the reader's language, so a one-click answer is not raw data. */
const POLICY_OPTION_KEYS: Readonly<Record<string, Readonly<Record<string, MessageKey>>>> = {
  measures: {
    convert: "languageProfile.measures.convert",
    transliterate: "languageProfile.measures.transliterate",
    mixed: "languageProfile.measures.mixed",
  },
  textualVariants: {
    omit: "languageProfile.textualVariants.omit",
    bracket: "languageProfile.textualVariants.bracket",
    footnote: "languageProfile.textualVariants.footnote",
  },
  headings: { none: "languageProfile.headings.none", pericope: "languageProfile.headings.pericope" },
}

function failureMessage(err: unknown, decision: ContextualDecisionView, t: TFunction): string {
  if (err instanceof ContextualApiError) {
    if (err.status === 403 && decision.factKey && profileSlotOfFactKey(decision.factKey)) {
      return t("projectDecisions.card.needsMaintainer")
    }
    const key = err.status === 400 && err.reason ? REJECTION_KEYS[err.reason as FactAnswerRejection] : undefined
    if (key) return t(key)
  }
  return t("autopilot.decisions.actionFailed")
}

export function DecisionCard({ decision, projectId, onResolved }: DecisionCardProps) {
  const t = useT()
  const [answer, setAnswer] = useState("")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const options = decision.options ?? []
  const profileKey = decision.factKey ? profileSlotOfFactKey(decision.factKey) !== null : false
  // A Language-profile slot takes only values it can hold, so its options are the answers.
  const freeText = options.length === 0 || !profileKey

  async function act(action: "answer" | "dismiss", payload: Record<string, unknown>) {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      await actOnContextualDecision(projectId, decision.id, action, payload)
      onResolved()
    } catch (err) {
      // A silent failure here reads as "your answer was recorded" when it
      // wasn't — the one thing this card must never do. Surface it and leave
      // the card interactive so the user can retry immediately.
      setFailure(failureMessage(err, decision, t))
    } finally {
      setBusy(false)
    }
  }

  const optionLabel = (option: { value: string; label?: string }) => {
    const key = decision.factKey ? POLICY_OPTION_KEYS[decision.factKey]?.[option.value] : undefined
    return key ? t(key) : (option.label ?? option.value)
  }

  return (
    <div
      data-testid="contextual-decision-card"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <p className="text-sm">{decision.reason}</p>
      {decision.fileId ? (
        <DecisionContext projectId={projectId} fileId={decision.fileId} cellIds={decision.cellIds} />
      ) : null}
      {decision.blastRadius > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("autopilot.decisions.blastRadius", { count: decision.blastRadius })}
        </p>
      )}
      {decision.factKey ? (
        <p className="text-xs text-muted-foreground">{t("projectDecisions.card.durable")}</p>
      ) : null}
      {options.length > 0 && (
        <div data-testid="decision-options" className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void act("answer", { answer: option.value })}
            >
              {optionLabel(option)}
            </Button>
          ))}
        </div>
      )}
      {freeText && (
        <Textarea
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder={
            options.length > 0 ? t("projectDecisions.card.otherAnswer") : t("autopilot.decisions.answerPlaceholder")
          }
          rows={2}
        />
      )}
      <div className="flex gap-2">
        {freeText && (
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
        )}
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
      {failure && (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      )}
    </div>
  )
}

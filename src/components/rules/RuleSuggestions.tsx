/**
 * Draft rule suggestions, shown in place at the bottom of the project rules
 * list. State lives in `useRuleSuggestions`; these are just its rows.
 */
import { useState, type FormEvent } from "react"
import { Check, Sparkles, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FillsTwiceIndicator } from "@/components/ui/fills-twice-indicator"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { SeverityBadge } from "@/components/rules/RuleSeverity"
import type { RuleCheck } from "@/lib/parsers/types"
import type { RuleDraft } from "@/hooks/useRuleSuggestions"
import { useT } from "@/lib/i18n/I18nProvider"

/** One-line, monospace description of what a rule's regex check does. */
export function RuleCheckSummary({ check }: { check: RuleCheck }) {
  const t = useT()
  return (
    <p className="font-mono text-[11px] leading-relaxed break-all">
      {check.type === "source-target-match" && (
        <>
          {t("rules.importReview.checkLabel.sourceTargetMatch")}{" "}
          <span className="font-semibold">{check.pattern}</span>
        </>
      )}
      {check.type === "target-forbids" && (
        <>
          {t("rules.importReview.checkLabel.targetForbids")}{" "}
          <span className="font-semibold">{check.targetPattern}</span>
        </>
      )}
      {check.type === "source-requires-target" && (
        <>
          {t("rules.importReview.checkLabel.sourceRequiresTargetPrefix")}{" "}
          <span className="font-semibold">{check.sourcePattern}</span>{" "}
          {t("rules.importReview.checkLabel.sourceRequiresTargetSuffix")}{" "}
          <span className="font-semibold">{check.targetPattern}</span>
        </>
      )}
    </p>
  )
}

export function RuleSuggestionItem({
  draft,
  onApprove,
  onDismiss,
}: {
  draft: RuleDraft
  onApprove: (id: string) => void
  onDismiss: (id: string) => void
}) {
  const t = useT()
  const { suggestion } = draft
  const approving = draft.status === "approving"
  return (
    <li
      data-flip-key={`draft-${draft.id}`}
      data-testid="rule-suggestion"
      aria-label={t("rules.suggestions.itemAriaLabel", { name: suggestion.name })}
      className="rounded-md border border-dashed border-primary/50 bg-primary/5 p-3"
    >
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{suggestion.name}</span>
            <SeverityBadge severity={suggestion.severity} />
            <Badge variant="outline" className="border-primary/40 text-primary">
              {t("rules.suggestions.draftBadge")}
            </Badge>
          </div>
          {suggestion.description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{suggestion.description}</p>
          )}
          <div className="mt-1.5 rounded bg-background/70 p-1.5">
            <RuleCheckSummary check={suggestion.check} />
          </div>
          {draft.evidence && (
            <p className="mt-1 text-[11px] text-muted-foreground italic">
              {t("rules.suggestions.evidence", { evidence: draft.evidence })}
            </p>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 ps-7">
        <Button size="sm" onClick={() => onApprove(draft.id)} disabled={approving}>
          {approving ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
          {t("rules.suggestions.addButton")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onDismiss(draft.id)} disabled={approving}>
          <X data-icon="inline-start" />
          {t("rules.suggestions.dismissButton")}
        </Button>
      </div>
    </li>
  )
}

/**
 * The last row of the list: ask for (more) suggestions, optionally about a
 * topic. The topic stays filled in, so "Suggest more" keeps to it.
 */
export function RuleSuggestionsFooter({
  onSuggest,
  hasSuggested,
  loading,
  message,
  isConfigured,
  cellsLoading,
  cellsError,
}: {
  onSuggest: (focus: string) => void
  hasSuggested: boolean
  loading: boolean
  message: { kind: "info" | "error"; text: string } | null
  isConfigured: boolean
  cellsLoading: boolean
  cellsError: Error | undefined
}) {
  const t = useT()
  const [focus, setFocus] = useState("")
  const blocked = !isConfigured || cellsLoading || Boolean(cellsError)

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!blocked && !loading) onSuggest(focus)
  }

  return (
    <li data-flip-key="suggestions-footer" className="rounded-md border border-dashed p-2">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
        <Input
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          placeholder={t("rules.suggestions.focusPlaceholder")}
          aria-label={t("rules.suggestions.focusAriaLabel")}
          disabled={blocked}
          className="h-8 min-w-48 flex-1"
        />
        <Button type="submit" size="sm" variant="outline" disabled={blocked || loading}>
          <Sparkles data-icon="inline-start" />
          {loading
            ? t("rules.suggestions.loading")
            : hasSuggested
              ? t("rules.suggestions.suggestMoreButton")
              : t("rules.suggestions.suggestButton")}
        </Button>
      </form>
      {/* AQU-1640: the shared wait graphic for a costly model call. Stays
          mounted so it can run out after the drafts are already in the list. */}
      <FillsTwiceIndicator
        pending={loading}
        label={t("rules.suggestions.loading")}
        className="mt-2 px-1"
      />
      {(message || blocked) && (
        <p
          role={message?.kind === "error" || cellsError ? "alert" : undefined}
          className={
            message?.kind === "error" || cellsError
              ? "mt-1.5 px-1 text-xs text-destructive"
              : "mt-1.5 px-1 text-xs text-muted-foreground"
          }
        >
          {cellsError
            ? t("rules.suggestFromEdits.corpusLoadFailed", { message: cellsError.message })
            : !isConfigured
              ? t("rules.importDialog.configureLlmFirst")
              : cellsLoading
                ? t("rules.suggestFromEdits.corpusLoading")
                : message?.text}
        </p>
      )}
    </li>
  )
}

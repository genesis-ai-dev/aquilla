// The card behind a smart-edit underline: the suggested wording, the team's
// own earlier correction as evidence, and Accept / Dismiss. Small on purpose —
// the evidence IS the explanation, so there is no "why" to generate.

import { Popover, PopoverContent } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import type { SmartEditSuggestion } from "@/lib/smart-edits/client"


/** Reason keys the harmonizer may send. A key the client does not know (a
 *  newer server) shows no reason rather than a raw key. */
const HARMONIZER_REASONS = [
  "harmonizer.quotes.closeHere",
  "harmonizer.reference.unclearSubject",
  "harmonizer.reference.impliedSubject",
  "harmonizer.sentence.brokenCase",
  "harmonizer.sentence.brokenOff",
  "harmonizer.sentence.runOn",
] as const
type HarmonizerReason = (typeof HARMONIZER_REASONS)[number]
function isHarmonizerReason(key: string): key is HarmonizerReason {
  return (HARMONIZER_REASONS as readonly string[]).includes(key)
}

export function SmartEditPopover({
  suggestion,
  anchor,
  onAccept,
  onDismiss,
  onClose,
}: {
  suggestion: SmartEditSuggestion
  anchor: HTMLElement
  onAccept: () => void
  onDismiss: () => void
  onClose: () => void
}) {
  const t = useT()
  const example = suggestion.examples[0]
  const count = suggestion.support.strong + suggestion.support.weak
  return (
    <Popover open onOpenChange={(open) => { if (!open) onClose() }}>
      <PopoverContent className="w-80 p-3 text-sm" sideOffset={6} anchor={anchor}>
        <div className="space-y-3" data-testid="smart-edit-popover">
          <div className="text-xs font-medium text-muted-foreground">{t("smartEdits.popoverTitle")}</div>
          {suggestion.flagOnly ? (
            <div className="font-medium">{suggestion.old}</div>
          ) : (
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-muted-foreground line-through">{suggestion.old}</span>
              <span aria-hidden>→</span>
              <span className="font-medium">{suggestion.new}</span>
            </div>
          )}
          {suggestion.tier === "harmonize" && (
            <div className="space-y-1 text-xs">
              {suggestion.reasonKey && isHarmonizerReason(suggestion.reasonKey) && (
                <p>{t(suggestion.reasonKey, suggestion.reasonValues)}</p>
              )}
              <p className="text-muted-foreground">{t("harmonizer.popoverNote")}</p>
            </div>
          )}
          {suggestion.tier === "llm" && (
            <div className="space-y-1 text-xs">
              {suggestion.reason && <p>{suggestion.reason}</p>}
              <p className="text-muted-foreground">{t("smartEdits.fromAi")}</p>
            </div>
          )}
          {count > 0 && <p className="text-xs text-muted-foreground">{t("smartEdits.evidence", { count })}</p>}
          {example && (
            <div className="space-y-1 rounded-md bg-muted/50 p-2 text-xs">
              {example.fromAiDraft && <div className="text-muted-foreground">{t("smartEdits.fromAiDraft")}</div>}
              <div><span className="text-muted-foreground">{t("smartEdits.exampleBefore")}: </span>{example.before}</div>
              <div><span className="text-muted-foreground">{t("smartEdits.exampleAfter")}: </span>{example.after}</div>
            </div>
          )}
          {suggestion.tier === "jev" && <p className="text-xs text-muted-foreground">{t("smartEdits.evidenceVerified")}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onDismiss}>{t("smartEdits.dismiss")}</Button>
            {!suggestion.flagOnly && <Button size="sm" onClick={onAccept}>{t("smartEdits.accept")}</Button>}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

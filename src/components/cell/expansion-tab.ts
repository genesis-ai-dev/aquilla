// Which tab an expanded cell opens on. Applied when the panel opens — once it
// is open, the user's choice (or an inline rule click) wins.

export type ExpansionTabOnOpen = "issues" | "audio" | "backtranslation"

export function initialExpansionTab({
  hasIssues,
  transcriptNeedsAttention,
  audioView,
}: {
  /** The line breaks a rule: its issues come first. */
  hasIssues: boolean
  /** Its recording's transcript does not say the text. */
  transcriptNeedsAttention: boolean
  /** The Audio view, where the line IS its audio (Sam, 2026-09-29): the
   *  Recording tab, not Back-translation, unless issues need seeing first. */
  audioView: boolean
}): ExpansionTabOnOpen {
  if (hasIssues) return "issues"
  if (transcriptNeedsAttention || audioView) return "audio"
  return "backtranslation"
}

// Which tab an expanded cell opens on. Applied when the panel opens — once it
// is open, the user's choice (or an inline rule click) wins.

export type ExpansionTabOnOpen = "issues" | "audio" | "backtranslation"

export function initialExpansionTab({
  hasIssues,
  transcriptNeedsAttention,
  audioLanguage,
}: {
  /** The line breaks a rule: its issues come first. */
  hasIssues: boolean
  /** Its recording's transcript does not say the text. */
  transcriptNeedsAttention: boolean
  /** The open language delivers Audio, so the line IS its audio (Sam,
   *  2026-09-29, for the Audio view; AQU-1758 for every view since it went):
   *  the Recording tab, not Back-translation, unless issues need seeing first. */
  audioLanguage: boolean
}): ExpansionTabOnOpen {
  if (hasIssues) return "issues"
  if (transcriptNeedsAttention || audioLanguage) return "audio"
  return "backtranslation"
}

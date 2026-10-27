// Which tab an expanded cell opens on. Applied when the panel opens — once it
// is open, the user's choice (or an inline rule click) wins.

export type ExpansionTabOnOpen = "issues" | "audio" | "backtranslation"

export function initialExpansionTab({
  hasIssues,
  transcriptNeedsAttention,
  audioLanguage,
  media = false,
}: {
  /** The line breaks a rule: its issues come first. */
  hasIssues: boolean
  /** Its recording's transcript does not say the text. */
  transcriptNeedsAttention: boolean
  /** The open language delivers Audio, so the line IS its audio (Sam,
   *  2026-09-29; AQU-1758 for every view): the Recording tab, not
   *  Back-translation, unless issues need seeing first. */
  audioLanguage: boolean
  /** AQU-1758 (Sam): in Media a row always opens on Recording, whatever the
   *  language delivers — unless issues need seeing first. The Text view
   *  keeps the rule above. */
  media?: boolean
}): ExpansionTabOnOpen {
  if (hasIssues) return "issues"
  if (media || transcriptNeedsAttention || audioLanguage) return "audio"
  return "backtranslation"
}

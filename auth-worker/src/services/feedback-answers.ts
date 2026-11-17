// The three answers on the "Report a problem" form (AQU-2467), shared by the
// Discord card and the support email so both show the same headings in the same
// order. Headings are English on purpose: they are read by the team, not the
// reporter.

export interface FeedbackAnswers {
  /** Required. Older clients send this as `description`. */
  whatHappened: string
  tryingTo?: string | null
  expected?: string | null
}

export const FEEDBACK_ANSWER_HEADINGS = {
  whatHappened: "What happened?",
  tryingTo: "What were you trying to do?",
  expected: "What did you expect to happen?",
} as const

export interface FeedbackAnswerSection {
  heading: string
  body: string
}

/** The answers that have text, in form order. An empty answer drops its heading. */
export function feedbackAnswerSections(a: FeedbackAnswers): FeedbackAnswerSection[] {
  const out: FeedbackAnswerSection[] = []
  for (const key of ["whatHappened", "tryingTo", "expected"] as const) {
    const body = a[key]?.trim()
    if (body) out.push({ heading: FEEDBACK_ANSWER_HEADINGS[key], body })
  }
  return out
}

/** Plain text, one heading line above each answer. */
export function formatAnswersText(a: FeedbackAnswers): string {
  return feedbackAnswerSections(a)
    .map((s) => `${s.heading}\n${s.body}`)
    .join("\n\n")
}

/** Discord markdown: bold heading above each answer. */
export function formatAnswersMarkdown(a: FeedbackAnswers): string {
  return feedbackAnswerSections(a)
    .map((s) => `**${s.heading}**\n${s.body}`)
    .join("\n\n")
}

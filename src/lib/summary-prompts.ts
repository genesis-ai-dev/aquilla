/**
 * summary-prompts.ts — the user-message prompts the "Summarize book/chapter"
 * buttons send to the translation agent.
 *
 * Kept tiny and pure so they're easy to test and tweak. The agent already
 * receives the focused file/cell context and the translator profile (system
 * prompt), so these only state scope + the slide's four-part structure
 * (Key Meaning / Important Insights / Application / Translation Notes).
 */

const STRUCTURE = [
  "- Key Meaning — what this passage means",
  "- Important Insights — the key points to understand",
  "- Application — how it connects to my context as the translator",
  "- Translation Notes — things to watch when translating it",
].join("\n")

const RESOURCES =
  "Use the available vetted Bible reference resources where they help, and tailor the summary to my translator profile."

export function bookSummaryPrompt(bookName: string): string {
  return `Summarize the book of ${bookName} for me as the translator. ${RESOURCES}\n\nStructure it as:\n${STRUCTURE}`
}

export function chapterSummaryPrompt(chapterRef: string): string {
  return `Summarize ${chapterRef} for me as the translator. ${RESOURCES}\n\nStructure it as:\n${STRUCTURE}`
}

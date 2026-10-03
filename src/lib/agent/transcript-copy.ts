/**
 * transcript-copy.ts — renders an agent conversation as readable markdown for
 * the "Copy chat" action (AQU-1652).
 *
 * The chat is a timeline of runs, not a list of messages, so the copy has to
 * reconstruct the turns the reader actually saw: the typed prompt (not the wire
 * text a slash command expanded into), with attached source chips as their
 * quoted wording, then the model's prose with the trailing `NEXT:` suggestion
 * markers stripped — those render as buttons, never as text, so copying them
 * would put something on the clipboard that was never on screen.
 *
 * Pure functions, no DOM: the clipboard write stays in the component so this
 * stays testable and reusable by any surface that renders runs.
 */

import { expandChipQuotes } from "./context-chip"
import type { AgentRunUi, TextItem } from "./run-state"
import { splitNextSteps } from "./suggestions"

export interface TranscriptLabels {
  /** Speaker label for the reader's own turns, e.g. "You". */
  user: string
  /** Speaker label for the agent's turns, e.g. the Coordinator's name. */
  assistant: string
}

/**
 * The reader's turn as text. Chips become their quoted wording; a run whose
 * wire text carries no chip legend copies the DISPLAYED prompt, so a slash
 * command stays the command the user typed rather than its expansion.
 */
export function userTurnText(run: AgentRunUi): string {
  const wire = run.wireContent
  if (!wire) return run.prompt.trim()
  const expanded = expandChipQuotes(wire)
  return (expanded === wire ? run.prompt : expanded).trim()
}

/**
 * The agent's prose for one run, matching what the timeline shows: every text
 * item in arrival order, with the final block's `NEXT:` lines removed.
 */
export function assistantTurnText(run: AgentRunUi): string {
  const texts = run.items.filter((item): item is TextItem => item.kind === "text")
  return texts
    .map((item, index) =>
      index === texts.length - 1 ? splitNextSteps(item.text).body : item.text,
    )
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim()
}

/**
 * The whole thread as markdown with speaker labels. Runs that produced no
 * prose contribute their failure message instead, so a copied transcript never
 * silently drops a turn the reader is looking at.
 */
export function formatTranscriptMarkdown(
  runs: readonly AgentRunUi[],
  labels: TranscriptLabels,
): string {
  const blocks: string[] = []
  for (const run of runs) {
    const prompt = userTurnText(run)
    if (prompt) blocks.push(`**${labels.user}:** ${prompt}`)
    const reply = assistantTurnText(run)
    if (reply) blocks.push(`**${labels.assistant}:** ${reply}`)
    else if (run.status === "error" && run.errorMessage?.trim()) {
      blocks.push(`**${labels.assistant}:** ${run.errorMessage.trim()}`)
    }
  }
  return blocks.join("\n\n")
}

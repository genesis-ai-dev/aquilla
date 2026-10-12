/**
 * Plain-text transcript of an agent conversation, for "Copy chat".
 *
 * Built from the run records rather than the rendered DOM, so the clipboard
 * gets what was said — the user's message as shown in their bubble (chips as
 * their quoted wording) and the agent's prose — without button labels, card
 * chrome or tool-call scaffolding.
 */

import { assistantTextOf, type AgentRunUi } from "./run-state"

export function chatTranscript(runs: readonly AgentRunUi[]): string {
  const turns: string[] = []
  for (const run of runs) {
    const prompt = run.prompt.trim()
    if (prompt) turns.push(`You: ${prompt}`)
    const reply = assistantTextOf(run)
    if (reply) turns.push(`Agent: ${reply}`)
  }
  return turns.join("\n\n")
}

/**
 * cell-context.ts — the focused-cell context passed to the AI agent.
 *
 * Previously defined in completion/chat-service.ts (the standalone chat
 * service, now removed). Relocated here so the agent surface owns the type
 * without depending on chat plumbing.
 */

export interface CellContext {
  sourceText: string
  translatedText: string
  /** Human-readable location label, e.g. "GEN 1:1" */
  context?: string
}

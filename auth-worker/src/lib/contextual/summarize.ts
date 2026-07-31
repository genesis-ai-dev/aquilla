// summarize — compress the construal into an L1 scene brief (graph node
// `summarize`, fast tier). Mirrors src/lib/brief L1 discipline: the budget is
// STATED in the prompt and HARD-ENFORCED by truncation — the L1 is injected
// into every draft prompt, so it can never blow the token budget. The full L2
// (deterministic markdown render of the construal) is retained alongside it.

import { chargeBudget, type Construal, type LlmCall, type RunBudget } from "./types"

/** Max L1 length in characters (~250 words) — same budget as the project
 *  brief (src/lib/brief/schema.ts L1_MAX_CHARS; not importable from the SPA). */
export const L1_MAX_CHARS = 1600

/** Deterministic L2 render — code, zero tokens, lossless. */
export function renderConstrualL2(construal: Construal): string {
  const lines = [
    `## Situation`,
    construal.situation || "(none)",
    ``,
    `## Participants`,
    ...(construal.participants.length > 0 ? construal.participants.map((p) => `- ${p}`) : ["(none)"]),
    ``,
    `## Tenor`,
    construal.tenor || "(none)",
    ``,
    `## Moves`,
    ...(construal.moves.length > 0 ? construal.moves.map((m, i) => `${i + 1}. ${m}`) : ["(none)"]),
  ]
  if (construal.openQuestions.length > 0) {
    lines.push(``, `## Open questions (genuine ambiguity — preserve)`)
    lines.push(...construal.openQuestions.map((q) => `- ${q}`))
  }
  return lines.join("\n")
}

export interface SummarizeResult {
  l1Summary: string
  /** True when the model call failed/was unaffordable and the L1 fell back to
   *  a hard-truncated L2 — reported, never silent. */
  fallback: boolean
}

export async function summarizeConstrual(deps: {
  construal: Construal
  llm: LlmCall
  budget: RunBudget
}): Promise<SummarizeResult> {
  const l2 = renderConstrualL2(deps.construal)
  const charge = chargeBudget(deps.budget, "fast")
  if (!charge.ok) {
    return { l1Summary: l2.slice(0, L1_MAX_CHARS), fallback: true }
  }
  const reply = await deps.llm({
    // [[ctx:summarize]] routes the scripted e2e mock (scripts/mock-openrouter.ts).
    system: `[[ctx:summarize]] Compress the following scene construal into a single plain-text scene brief of AT MOST ${L1_MAX_CHARS} characters. Keep: the situation, who is involved and their relationship, the sequence of moves, and every open question verbatim. Drop nothing a translator drafting this scene would need. Output the brief text only — no headings, no JSON, no preamble.`,
    user: l2,
    tier: "fast",
    maxTokens: 800,
    temperature: 0,
  })
  const text = reply.trim()
  if (!text) return { l1Summary: l2.slice(0, L1_MAX_CHARS), fallback: true }
  return { l1Summary: text.slice(0, L1_MAX_CHARS), fallback: false }
}

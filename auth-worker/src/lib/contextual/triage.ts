// triage — per-cell "does a human need to look at this?" for staged drafts
// (docs/superpowers/specs/2026-09-30-agent-pr-threads-design.md §2).
//
// Stored in the draft's existing `verdicts` jsonb next to the finding codes:
//   { "<code>": "flag", _triage: "human" | "advisory", _severity: "0".."4",
//     _decidedBy: "model" | "heuristic" | "mixed" }
// Codes and categories only — never model prose.

import type { DecideInput, DecideResult, JevAnswer, JevQuestion } from "../jev/decide"

export interface TriageCell {
  cellId: string
  ref: string | null
  source: string
  text: string
  findings: string[]
}

export interface TriageCall {
  (input: Pick<DecideInput, "state" | "questions" | "fallback">): Promise<DecideResult>
}

const HUMAN_MIN = 0.5
const TEXT_MAX = 400

export function fallbackTriage(findings: string[]): { triage: "human" | "advisory"; severity: number } {
  if (findings.some((f) => f === "unsupported" || f.startsWith("dissent:"))) return { triage: "human", severity: 3 }
  if (findings.some((f) => f.startsWith("lint:"))) return { triage: "advisory", severity: 2 }
  return { triage: "advisory", severity: findings.length > 0 ? 1 : 0 }
}

const SEVERITY_CRITERIA = [
  "No risk to meaning.",
  "Cosmetic: wording could be smoother.",
  "Minor: a rule or preference may be broken, meaning intact.",
  "Serious: meaning may be wrong or unsupported by the source.",
  "Critical: the draft likely says something the source does not.",
]

function questionsFor(cells: TriageCell[]): Record<string, JevQuestion> {
  const q: Record<string, JevQuestion> = {}
  cells.forEach((_, i) => {
    q[`c${i}_needs_human`] = {
      type: "noul",
      instructions: { cell: `cell ${i}`, question: "Should a translator review this draft before it is approved?" },
      criteria: {
        true: "The findings point at a real risk to meaning, terminology, or fidelity.",
        false: "The findings are minor; approving without a close look is reasonable.",
      },
    }
    q[`c${i}_severity`] = {
      type: "score",
      instructions: { cell: `cell ${i}`, question: "How serious is the risk the findings describe?" },
      criteria: SEVERITY_CRITERIA,
    }
  })
  return q
}

function fallbackAnswers(cells: TriageCell[]): Record<string, JevAnswer> {
  const a: Record<string, JevAnswer> = {}
  cells.forEach((c, i) => {
    const f = fallbackTriage(c.findings)
    a[`c${i}_needs_human`] = { kind: "noul", p: f.triage === "human" ? 1 : 0 }
    a[`c${i}_severity`] = { kind: "score", score: f.severity }
  })
  return a
}

const clip = (t: string) => (t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t)

/** Verdicts for every cell, keyed by cell id. Never throws. */
export async function triageVerdicts(
  cells: TriageCell[],
  judge: TriageCall,
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>(cells.map((c) => [c.cellId, {}]))
  const flagged = cells.filter((c) => c.findings.length > 0)
  if (flagged.length === 0) return out

  let result: DecideResult
  try {
    result = await judge({
      state: {
        cells: flagged.map((c, index) => ({
          index,
          ref: c.ref,
          source: clip(c.source),
          draft: clip(c.text),
          findings: c.findings,
        })),
      },
      questions: questionsFor(flagged),
      fallback: () => fallbackAnswers(flagged),
    })
  } catch (err) {
    console.warn("[triage] judge failed; using fixed rules:", err)
    result = { answers: fallbackAnswers(flagged), decidedBy: "heuristic", model: null, usage: null }
  }

  flagged.forEach((c, i) => {
    const human = result.answers[`c${i}_needs_human`]
    const severity = result.answers[`c${i}_severity`]
    const p = human?.kind === "noul" ? human.p : 0
    const level = severity?.kind === "score" ? Math.max(0, Math.min(4, Math.round(severity.score))) : 0
    out.set(c.cellId, {
      ...Object.fromEntries(c.findings.map((f) => [f, "flag"])),
      _triage: p >= HUMAN_MIN ? "human" : "advisory",
      _severity: String(level),
      _decidedBy: result.decidedBy,
    })
  })
  return out
}

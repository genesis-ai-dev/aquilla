// Glossary QA (Matecat-parity run) —
// https://guides.matecat.com/work-with-the-termbase-while-translating:
//   - a source term with an approved rendering must appear in the target at
//     least as many times as the term appears in the source;
//   - forbidden renderings appearing in the target are flagged.
// Operates on Aquilla's Concept model so both the in-app terminology and
// imported termbases (qa/termbase.ts) share one checker.
import type { Concept } from "@/lib/terminology/types"
import type { QaIssue } from "./checks"

export interface GlossaryIssue extends Omit<QaIssue, "check"> {
  check: "glossary"
  term: string
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Occurrences of a term with word-ish boundaries, case-insensitive. */
const countTerm = (text: string, term: string): number => {
  if (!term) return 0
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, "giu")
  return (text.match(re) ?? []).length
}

export function checkGlossary(source: string, target: string, concepts: Concept[]): GlossaryIssue[] {
  if (!target.trim()) return []
  const issues: GlossaryIssue[] = []
  for (const concept of concepts) {
    if (concept.status !== "active") continue
    const srcCount = countTerm(source, concept.sourceTerm)

    // forbidden renderings are flagged regardless of the source term appearing
    for (const r of concept.renderings) {
      if (r.status === "forbidden" && countTerm(target, r.rendering) > 0) {
        issues.push({
          check: "glossary",
          severity: "error",
          term: concept.sourceTerm,
          message: `forbidden term "${r.rendering}" used in target`,
        })
      }
    }

    if (srcCount === 0) continue
    const approved = concept.renderings.filter((r) => r.status !== "forbidden")
    if (approved.length === 0) continue
    const tgtCount = approved.reduce((sum, r) => sum + countTerm(target, r.rendering), 0)
    if (tgtCount < srcCount) {
      issues.push({
        check: "glossary",
        severity: "warning",
        term: concept.sourceTerm,
        message: `"${concept.sourceTerm}" appears ${srcCount}× in source but approved rendering(s) appear ${tgtCount}× in target`,
      })
    }
  }
  return issues
}

// judge-participants — the Jev questions about participants (AQU-1701; design
// doc §9.3). judgeExpectations batches them with the span's other questions.
// Each is asked only where the pack says it applies AND code could not
// settle it:
//
//   referent (P13)      "Is it clear in this translation that {participant}
//                       is the one who {verb}?"
//                       — two or more active participants share gender and
//                         number, the cell refers to one of them only as a
//                         verb's implied subject, the translation has one of
//                         the profile's third-person forms, and it does not
//                         name that participant. Asked of the whole cell: no
//                         word alignment says which target word is the
//                         pronoun (the Bridge links live on another stack).
//   we_inclusive (P9)   "Does 'we' here include the people being spoken to?"
//                       — the profile says "we" marks clusivity but does not
//                         list forms for both kinds, so P9 and X4 cannot
//                         decide in code, and a decision or the pack says
//                         which kind this "we" is.
//   introduced (P11)    "Is {participant} clearly identified by name or
//                       description in this verse of the translation?"
//                       — the participant's first mention after a pericope
//                         boundary is a name in the Greek, and the
//                         translation does not use the participant's name.
//
// The pack facts come from db/shared/bible-checks/reference-tracking.ts and
// compile-participants.ts. A participant is named in a question by the
// project's agreed name, else by the pack's label.

import { acceptedRenderings, clusivityDecisionFor, entityLabel } from "../../../../db/shared/bible-checks/agreed-names"
import { formSpans, nameSpans } from "../../../../db/shared/bible-checks/name-match"
import type { CellParticipants, Clusivity } from "../../../../db/shared/bible-checks/participant-types"
import type { LanguageProfile } from "../../../../db/shared/language-profile"
import type { Candidate, JudgeCell } from "./judge-expectations"

/** How a question names a participant: the agreed name, else the pack's label ("the brother" for a local one). */
function nameIn(p: CellParticipants, entity: string, refs: readonly string[]): string {
  const agreed = acceptedRenderings(p.names, entity, refs)[0]
  if (agreed) return agreed
  const label = entityLabel(p.names, entity)
  return entity.startsWith("local:") ? `the ${label}` : label
}

/** The translation names the participant: an agreed name or, with none agreed, the pack's label without its note in brackets. */
function isNamed(text: string, p: CellParticipants, entity: string, refs: readonly string[]): boolean {
  const agreed = acceptedRenderings(p.names, entity, refs)
  const names = agreed.length > 0 ? agreed : [entityLabel(p.names, entity).replace(/\s*\([^)]*\)\s*$/u, "")]
  return names.some((name) => name.trim() !== "" && nameSpans(text, name).length > 0)
}

export function referentCandidate(cell: JudgeCell, profile: LanguageProfile): Candidate {
  const p = cell.expectation?.participants
  if (!cell.expectation || !p || p.ambiguousSubjects.length === 0) return null
  // A pronoun-like token: only the profile's third-person forms say what one is.
  if (formSpans(cell.text, profile.pronouns?.thirdPerson?.forms ?? []).length === 0) return null
  const refs = cell.expectation.refs
  const subject = p.ambiguousSubjects.find((s) => !isNamed(cell.text, p, s.entity, refs))
  if (!subject) return { decided: "pass" }
  const name = nameIn(p, subject.entity, refs)
  return {
    ask: {
      check: "referent",
      question: `Is it clear in this translation that ${name} is the one who ${subject.gloss}?`,
      passWhenYes: true,
      repair: `Make clear that ${name} is the one who ${subject.gloss}.`,
    },
  }
}

/** The kind of "we" here: a recorded decision first (X4), else the pack's, when every decided "we" of the cell agrees (P9). */
export function expectedClusivity(p: CellParticipants, refs: readonly string[]): Clusivity | null {
  const decision = clusivityDecisionFor(p.names, refs)
  if (decision) return decision.value.trim().toLowerCase() === "inclusive" ? "inclusive" : "exclusive"
  const kinds = new Set(p.firstPlural.flatMap((m) => (m.clusivity ? [m.clusivity] : [])))
  return kinds.size === 1 ? [...kinds][0] : null
}

export function weInclusiveCandidate(cell: JudgeCell, profile: LanguageProfile): Candidate {
  const first = profile.pronouns?.firstPersonPlural
  const p = cell.expectation?.participants
  if (!first?.clusivity || !cell.expectation || !p || p.firstPlural.length === 0) return null
  // With forms for both kinds, P9 and X4 decide in code.
  if (first.inclusive?.length && first.exclusive?.length) return null
  const want = expectedClusivity(p, cell.expectation.refs)
  if (!want) return null
  return {
    ask: {
      check: "we_inclusive",
      question: "Does 'we' here include the people being spoken to?",
      passWhenYes: want === "inclusive",
      repair:
        want === "inclusive"
          ? 'Use the inclusive "we": it includes the people being spoken to.'
          : 'Use the exclusive "we": it leaves out the people being spoken to.',
    },
  }
}

export function introducedCandidate(cell: JudgeCell): Candidate {
  const p = cell.expectation?.participants
  if (!cell.expectation || !p || p.introduced.length === 0) return null
  const refs = cell.expectation.refs
  const missing = p.introduced.find((i) => !isNamed(cell.text, p, i.entity, refs))
  if (!missing) return { decided: "pass" }
  return {
    ask: {
      check: "introduced",
      question: `Is ${nameIn(p, missing.entity, refs)} clearly identified by name or description in this verse of the translation?`,
      passWhenYes: true,
    },
  }
}

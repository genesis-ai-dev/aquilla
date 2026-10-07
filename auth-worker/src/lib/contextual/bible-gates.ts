// bible-gates — the `bkp:` expectation gates on autopilot drafts (AQU-1690).
//
// The shared evaluator (db/shared/bible-checks) checks a draft's text against
// the cell's compiled expectation and the project's Language profile — the
// same code the editor's built-in rules run. Here its findings become:
//   • flags on the draft, with rule ids `bkp:<check>`, counted APART from
//     lint (router.ts): they have a cheap repair of their own and must not buy
//     the deep verifier panel;
//   • templated English constraints for that repair (warning findings only;
//     info findings are advisory codes);
//   • verdict values at staging: the finding's reason and pack evidence as
//     flat params, which the review UI formats with AQU-1688's messages.

import { evaluateCell, isBibleCheckDormant } from "../../../../db/shared/bible-checks/evaluate"
import { bibleReasonParams, encodeBibleParams } from "../../../../db/shared/bible-checks/params"
import { markSetForDepth } from "../../../../db/shared/bible-checks/quote-scan"
import type { BibleCheckReadiness } from "../../../../db/shared/bible-checks/participant-types"
import {
  BIBLE_CHECK_DEFAULT_SEVERITY,
  isBibleCheckId,
  type BibleCheckFinding,
  type CellExpectation,
} from "../../../../db/shared/bible-checks/types"
import type { CellFacts, FactEntity } from "../../../../db/shared/bible-facts/types"
import type { LanguageProfile } from "../../../../db/shared/language-profile"

export const BIBLE_FINDING_PREFIX = "bkp:"

/** A `bkp:` rule id or finding code. */
export function isBibleCode(code: string): code is `bkp:${string}` {
  return code.startsWith(BIBLE_FINDING_PREFIX)
}

export interface BibleGate {
  expectations: ReadonlyMap<string, CellExpectation>
  profile: LanguageProfile
}

/** The evaluator's findings for one cell's text; empty when the pack says nothing about the cell. */
export function bibleFindings(gate: BibleGate, cellId: string, text: string): BibleCheckFinding[] {
  return evaluateCell(text, gate.expectations.get(cellId), gate.profile)
}

/**
 * A finding the drafter is asked to repair, and that sends the cell to a
 * person if it survives: warning severity. Info findings (V7–V9, a
 * rhetorical question) stay advisory codes.
 */
export function isRepairable(finding: Pick<BibleCheckFinding, "severity">): boolean {
  return finding.severity === "warning"
}

/** The severity a stored `bkp:` code stands for. Jev-confirmed codes (V13, M3, P8) are only stored when they failed an ACTIVE question, so they count as warnings. */
export function bibleCodeSeverity(code: string): "warning" | "info" {
  return isBibleCheckId(code) ? BIBLE_CHECK_DEFAULT_SEVERITY[code] : "warning"
}

/** Verdict value for a finding: its params and pack evidence, encoded. */
export function bibleVerdictValue(finding: BibleCheckFinding): string {
  return encodeBibleParams(bibleReasonParams(finding))
}

// ── Stage-time re-check ─────────────────────────────────────────────────────

export interface StageRecheck {
  /** The cell's finding codes, with the evaluator's codes taken from the FINAL text. */
  findings: string[]
  /** Verdict values for the evaluator's codes: encoded params and evidence. */
  values: Record<string, string>
  /** A warning survived: the cell is staged for a person (`_triage: "human"`), never skipped. */
  residual: boolean
}

/** AQU-1699: what the project's decisions and terminology switch on, as the file's expectations carry it. */
function gateReadiness(gate: BibleGate): BibleCheckReadiness | undefined {
  for (const expectation of gate.expectations.values()) {
    if (expectation.participants) return expectation.participants.names.readiness
  }
  return undefined
}

/**
 * Re-check a cell's final text just before it is staged. The evaluator's
 * codes recorded during the run described an earlier text, so they are
 * replaced by what the final text gets. A recorded `bkp:` code the evaluator
 * cannot produce with this profile (its check is dormant) came from an
 * active Jev question, and is kept.
 */
export function recheckForStage(
  gate: BibleGate,
  cellId: string,
  text: string,
  findings: readonly string[],
): StageRecheck {
  const fresh = bibleFindings(gate, cellId, text)
  const readiness = gateReadiness(gate)
  const kept = findings.filter((code) => !(isBibleCheckId(code) && !isBibleCheckDormant(code, gate.profile, readiness)))
  const out = [...kept]
  const values: Record<string, string> = {}
  for (const finding of fresh) {
    if (!out.includes(finding.code)) out.push(finding.code)
    values[finding.code] = bibleVerdictValue(finding)
  }
  return {
    findings: out,
    values,
    residual: out.some((code) => isBibleCode(code) && bibleCodeSeverity(code) === "warning"),
  }
}

/** The triage verdicts with the re-check applied: evidence values, and a person for a residual warning. */
export function withBibleVerdicts(
  verdicts: Readonly<Record<string, string>>,
  recheck: StageRecheck | null,
): Record<string, string> {
  if (!recheck) return { ...verdicts }
  const out: Record<string, string> = { ...verdicts, ...recheck.values }
  if (recheck.residual) {
    out._triage = "human"
    out._severity = String(Math.max(3, Number.parseInt(out._severity ?? "0", 10) || 0))
  }
  return out
}

// ── Templated repair constraints ────────────────────────────────────────────

function nameOf(entity: FactEntity | null | undefined): string | null {
  if (!entity) return null
  return entity.rendering ?? entity.label
}

/** Who speaks the quotation at `level` that opens, closes or continues here. */
function speakerAt(facts: CellFacts | undefined, level: number, want: "opens" | "closes" | "any"): string | null {
  const speech = facts?.speeches.find(
    (s) => s.level === level && !s.selfProjected && (want === "any" || s[want]),
  )
  return nameOf(speech?.speaker)
}

function marks(profile: LanguageProfile, level: number): { open: string; close: string } | null {
  const levels = profile.quoteMarks?.levels
  if (!levels || levels.length === 0) return null
  // The marks the evaluator expects at this depth.
  return levels[markSetForDepth(level, levels.length) - 1] ?? null
}

/**
 * One English constraint for the redraft, from a finding and the cell's
 * facts. Deterministic: the same failure always asks for the same fix.
 */
export function bibleConstraint(finding: BibleCheckFinding, facts: CellFacts | undefined, profile: LanguageProfile): string {
  const level = Number(finding.params.level ?? "1")
  const pair = marks(profile, level)
  const open = pair ? ` with ${pair.open}` : ""
  const close = pair ? ` with ${pair.close}` : ""
  switch (finding.reason) {
    case "open-missing": {
      const who = speakerAt(facts, level, "opens")
      return `Open the level-${level} quotation${open} where ${who ? `${who}'s` : "the quoted"} words begin.`
    }
    case "close-missing": {
      const who = speakerAt(facts, level, "closes")
      return `Close the level-${level} quotation${close} where ${who ? `${who}'s` : "the quoted"} words end.`
    }
    case "close-after-aside": {
      const who = speakerAt(facts, level, "closes")
      return `Close ${who ? `${who}'s` : "the"} quotation${close} before the words that follow it in this verse; they are not part of the quotation.`
    }
    case "close-in-continuing-speech": {
      const who = speakerAt(facts, level, "any")
      return `Do not close the level-${level} quotation in this verse: ${who ? `${who}'s` : "the quoted"} words continue in the next one.`
    }
    case "wrong-level-marks":
      return `Mark the level-${level} quotation (a quotation inside a quotation) with ${finding.params.open ?? ""} … ${finding.params.close ?? ""}.`
    case "question-mark-missing":
      return "Keep this a question, as the source asks one: end it with a question mark or the language's question marker."
    case "marks-without-speech":
      return "Use no quotation marks here except around a short title or term: nobody speaks in this verse."
    case "interruption-not-marked":
      return `Close the level-${level} quotation before the narrator's interruption and reopen it after.`
    case "self-projection-adds-level":
      return `Do not add a level-${level} quotation here: the speaker reports their own words without new quotation marks.`
    // AQU-1697: check pack A. Only M3's "negation-missing" is a warning by
    // default, so it is the one autopilot repairs; the rest stay advisory.
    case "number-missing":
      return `Keep the number ${finding.params.value ?? ""}: the source states it in this verse.`
    case "ordinal-missing":
      return `Keep the ordinal number ${finding.params.value ?? ""} (as in "the third day"): the source states it in this verse.`
    case "negation-missing":
      return 'Keep the negation: the source says "not" here, and without it the meaning is reversed.'
    case "negation-fewer":
      return `Keep every negation: the source negates ${finding.params.expected ?? ""} times in this verse.`
    case "sentence-ends-early":
      return "Do not end the sentence at the end of this verse: the source sentence goes on into the next verse."
    case "variant-not-omitted":
      return `Leave out ${finding.evidence.kind === "variant" ? finding.evidence.passage : "this verse"}: the project omits verses that the oldest manuscripts lack.`
    case "variant-not-bracketed":
      return `Put ${finding.evidence.kind === "variant" ? finding.evidence.passage : "this verse"} in square brackets, as the project does for verses some manuscripts lack.`
    case "variant-no-footnote":
      return `Add a footnote for ${finding.evidence.kind === "variant" ? finding.evidence.passage : "this verse"}, as the project does for verses some manuscripts lack.`
    case "heading-missing":
      return "Add a section heading before this passage."
    case "heading-inside-pericope":
      return "Remove this heading: it stands inside a passage."
    case "verse-not-in-pack":
    case "pack-verse-without-cell":
      return `Check the verse numbering of ${finding.evidence.kind === "speech" ? finding.evidence.startRef : finding.evidence.refs.join(", ")}.`
    default:
      return packBConstraint(finding)
  }
}

/**
 * AQU-1699: check pack B. P5 (a person) and P6 are the warnings autopilot
 * repairs; the rest stay advisory, but every reason has its sentence.
 */
function packBConstraint(finding: BibleCheckFinding): string {
  const p = finding.params
  const name = p.name ?? "this person"
  const rendering = p.rendering ? `"${p.rendering}"` : "the project's name"
  switch (finding.reason) {
    case "name-missing":
      return `Use ${rendering} for ${name} here: the source names them in this verse.`
    case "name-variant-different":
    case "name-variant-none":
      return `Call ${name} "${p.usual ?? ""}" here, as the rest of the file does.`
    case "homonym-name":
      return `Use ${rendering} for ${name} here, not "${p.found ?? ""}", which is the name of ${p.other ?? "someone else"}.`
    case "name-form-missing":
      return `The source calls ${name} "${p.form ?? ""}" here: use the project's rendering of that form, ${rendering}.`
    case "name-not-in-source":
      return `Do not name "${p.found ?? ""}" here: the source of this verse does not mention ${name}.`
    case "subject-name-wrong":
      return `The one who acts here is ${name}${p.rendering ? ` ("${p.rendering}")` : ""}, not "${p.found ?? ""}".`
    case "you-number-missing":
    case "you-number-wrong":
      return `Use the ${p.number === "plural" ? "plural" : "singular"} "you" here: every "you" in the source of this verse speaks to ${p.number === "plural" ? "several people" : "one person"}.`
    case "clusivity-missing":
    case "clusivity-wrong":
      return p.clusivity === "inclusive"
        ? 'Use the inclusive "we" here: it includes the people spoken to.'
        : 'Use the exclusive "we" here: it does not include the people spoken to.'
    case "group-number-missing":
      return `Use the ${p.number ?? "dual"} form here: the pronoun refers to ${p.size ?? "a few"} people (${name}).`
    case "divine-name-missing":
    case "divine-name-swapped": {
      const meaning =
        p.divine === "kyrios-jesus" ? "κύριος means Jesus" : p.divine === "kyrios-god" ? "κύριος means God" : "πνεῦμα means the Holy Spirit"
      return `Here ${meaning}: render it ${rendering}${p.found ? `, not "${p.found}"` : ""}.`
    }
    case "deity-pronoun-lowercase":
      return "Capitalize the pronouns that refer to God, Jesus or the Holy Spirit, as the house style does."
    case "quotation-differs":
      return `Render the repeated quotation as in ${p.other ?? "its first occurrence"}.`
    default:
      return "Check this verse against the Bible data."
  }
}

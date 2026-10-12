/**
 * AQU-1711: the terminology verdict table the editor and autopilot must agree
 * on. It is the terminology twin of src/lib/rules/__fixtures__/rule-lint-parity.ts
 * (AQU-1705), which covers hand-authored project rules.
 *
 * A project's key terms have two readers. The editor compiles each concept
 * into `term:` rules (compileConceptsToRules → checkRulesForCell) and marks
 * what the PERSON sees. Autopilot's lintTerminology
 * (auth-worker/src/lib/contextual/project-context.ts) decides what the MODEL
 * is told: its flags drive the risk router and the redraft loop. When the two
 * disagree, autopilot rewrites lines the person sees as fine and stages lines
 * the person sees as broken.
 *
 * Both suites run every row: terminology-lint-parity.test.ts beside this
 * folder through the editor, and auth-worker's terminology-lint-parity.test.ts
 * through lintTerminology. `editor` is the editor's verdict. `server` is set
 * only where the two are known to differ, and names the ticket that closes
 * the gap; when that ticket lands, delete `server` and fix `editor`.
 *
 * Plain data on purpose: auth-worker's tsc and Vitest import this file by
 * relative path and cannot resolve the SPA's `@/` aliases.
 */

import type { TermMatchingSettings, TermMatchOptions, TermRendering } from "../model"

/** The fields of a `Concept` (../types) that matching reads. */
export interface ParityConcept {
  id: string
  sourceTerm: string
  renderings: TermRendering[]
  status: "active" | "draft" | "deprecated"
  createdAt: string
  caseSensitive?: boolean
  match?: TermMatchOptions
}

export interface TerminologyLintParityCase {
  /** What the row proves. */
  name: string
  concepts: ParityConcept[]
  /** The project's affix inventory (ProjectWideSettings.termMatching). */
  termMatching?: TermMatchingSettings
  source: string
  target: string
  /** Rule ids the editor marks on the cell, in rule order. */
  editor: string[]
  /** A known difference: what autopilot flags instead, until a ticket lands. */
  server?: { flagged: string[]; until: string }
}

function concept(
  id: string,
  sourceTerm: string,
  renderings: TermRendering[],
  more: Partial<ParityConcept> = {},
): ParityConcept {
  return { id, sourceTerm, renderings, status: "active", createdAt: "2026-10-06T00:00:00.000Z", ...more }
}

const GRACE = concept("grace", "grace", [{ rendering: "gracia", status: "preferred" }])
const LORD = concept("lord", "LORD", [{ rendering: "SEÑOR", status: "preferred" }], { caseSensitive: true })
const BAPTIZE = concept("baptize", "baptize", [
  { rendering: "bautizar", status: "preferred" },
  { rendering: "sumergir", status: "forbidden" },
])
// Hebrew: bet, resh, alef with qamats. BARA_DAGESH adds a dagesh to the bet.
const BARA = "בָרָא"
const BARA_DAGESH = "בָּרָא"

export const TERMINOLOGY_LINT_PARITY_CASES: TerminologyLintParityCase[] = [
  // Counts: one approved rendering for each time the source term appears.
  {
    name: "counts: 'grace upon grace' needs two renderings",
    concepts: [GRACE],
    source: "grace upon grace",
    target: "gracia sobre favor",
    editor: ["term:grace:approved"],
  },
  {
    name: "counts: an extra rendering is flagged too",
    concepts: [GRACE],
    source: "by grace",
    target: "por gracia y gracia",
    editor: ["term:grace:approved"],
  },
  {
    name: "counts: equal counts pass",
    concepts: [GRACE],
    source: "grace upon grace",
    target: "gracia sobre gracia",
    editor: [],
  },
  {
    name: "counts: preferred and admitted renderings both count",
    concepts: [
      concept("grace-any", "grace", [
        { rendering: "gracia", status: "preferred" },
        { rendering: "favor", status: "admitted" },
      ]),
    ],
    source: "grace upon grace",
    target: "gracia sobre favor",
    editor: [],
  },
  {
    name: "the concept does not apply when the source lacks the term",
    concepts: [GRACE],
    source: "by faith",
    target: "por fe",
    editor: [],
  },
  {
    name: "each concept is judged on its own, in termbase order",
    concepts: [GRACE, concept("faith", "faith", [{ rendering: "fe", status: "preferred" }])],
    source: "by grace through faith",
    target: "por favor mediante la confianza",
    editor: ["term:grace:approved", "term:faith:approved"],
  },

  // Wildcards: `*` stands for the rest of an inflected word, on both sides.
  {
    name: "wildcard: `baptiz*` matches 'baptized' and requires `bautiz*`",
    concepts: [concept("baptize-w", "baptiz*", [{ rendering: "bautiz*", status: "preferred" }])],
    source: "he baptized them",
    target: "los sumergió",
    editor: ["term:baptize-w:approved"],
  },
  {
    name: "wildcard: an inflected rendering satisfies `bautiz*`",
    concepts: [concept("baptize-w", "baptiz*", [{ rendering: "bautiz*", status: "preferred" }])],
    source: "he baptized them",
    target: "los bautizó",
    editor: [],
  },

  // Case: ignored unless the concept is case-sensitive, on both sides.
  {
    name: "case is ignored by default: 'Grace' bears `grace`",
    concepts: [GRACE],
    source: "Grace abounds",
    target: "abunda el favor",
    editor: ["term:grace:approved"],
  },
  {
    name: "caseSensitive: `LORD` does not match 'lord'",
    concepts: [LORD],
    source: "the lord of the manor",
    target: "el dueño de la finca",
    editor: [],
  },
  {
    name: "caseSensitive applies to renderings too: 'Señor' is not `SEÑOR`",
    concepts: [LORD],
    source: "the LORD is my shepherd",
    target: "el Señor es mi pastor",
    editor: ["term:lord:approved"],
  },
  {
    name: "caseSensitive: `LORD` with `SEÑOR` passes",
    concepts: [LORD],
    source: "the LORD is my shepherd",
    target: "el SEÑOR es mi pastor",
    editor: [],
  },

  // Term matching settings (AQU-1271): forms, exclusions, project affixes.
  {
    name: "an extra source form makes the concept apply",
    concepts: [concept("grace-forms", "grace", [{ rendering: "gracia", status: "preferred" }], { match: { forms: ["favour"] } })],
    source: "by his favour",
    target: "por su favor",
    editor: ["term:grace-forms:approved"],
  },
  {
    name: "an excluded form does not make the concept apply",
    concepts: [
      concept("grace-excl", "grace*", [{ rendering: "gracia", status: "preferred" }], {
        match: { excludedForms: ["graceful"] },
      }),
    ],
    source: "a graceful dancer",
    target: "una bailarina elegante",
    editor: [],
  },
  {
    name: "a project prefix extends the source match ('un' + grace)",
    concepts: [GRACE],
    termMatching: { prefixes: ["un"], suffixes: [] },
    source: "by ungrace",
    target: "por desgracia",
    editor: ["term:grace:approved"],
  },

  // Combining marks: word boundaries treat a mark as part of the word.
  {
    name: "combining marks: `cafe` does not match inside a decomposed 'café'",
    concepts: [concept("cafe", "cafe", [{ rendering: "cafetería", status: "preferred" }])],
    source: "the café opens",
    target: "abre el local",
    editor: [],
  },
  {
    name: "combining marks: a pointed Hebrew term does not match mid-word after a sheva",
    concepts: [concept("bara", BARA, [{ rendering: "created", status: "preferred" }])],
    source: `וְ${BARA}`,
    target: "and he made",
    editor: [],
  },
  {
    name: "mark folding: a pointed term matches the same consonants pointed differently",
    concepts: [concept("bara", BARA_DAGESH, [{ rendering: "created", status: "preferred" }])],
    source: BARA,
    target: "and he made",
    editor: ["term:bara:approved"],
  },

  // Forbidden renderings.
  {
    name: "forbidden: a forbidden rendering is flagged when the source has the term",
    concepts: [BAPTIZE],
    source: "to baptize them",
    target: "sumergir y bautizar",
    editor: ["term:baptize:forbidden:sumergir"],
  },
  {
    name: "forbidden: a concept with only forbidden renderings still checks them",
    concepts: [concept("jehovah", "LORD", [{ rendering: "Jehová", status: "forbidden" }])],
    source: "the LORD said",
    target: "Jehová dijo",
    editor: ["term:jehovah:forbidden:Jehová"],
  },
  {
    name: "forbidden: the editor flags a forbidden rendering even when the source lacks the term",
    concepts: [BAPTIZE],
    source: "to lower the net into the water",
    target: "para sumergir la red en el agua",
    editor: ["term:baptize:forbidden:sumergir"],
    // Autopilot applies the intended source condition; the editor does not yet.
    server: { flagged: [], until: "AQU-1712" },
  },

  // Never flagged.
  {
    name: "a whitespace-only translation is not checked",
    concepts: [GRACE],
    source: "grace",
    target: "   ",
    editor: [],
  },
  {
    name: "a draft concept constrains nothing",
    concepts: [concept("grace-draft", "grace", [{ rendering: "gracia", status: "preferred" }], { status: "draft" })],
    source: "grace",
    target: "favor",
    editor: [],
  },
]

// Harmonizer — cross-cell checks organised by SFL metafunction (AQU-1657).
//
// A translation can be right cell by cell and still wrong as a text: a quote
// that opens in one verse and never closes, a participant called by name where
// the target language would use a pronoun, a connective that contradicts the
// one before it. Those are properties of the TEXTUAL metafunction (and later
// the interpersonal and ideational ones), and they only show up across cells.
//
// Each check is its own module with the same three steps, so checks can be
// built, evaluated and improved one at a time:
//
//   plan       deterministic. Reads the passage and the way THIS project
//              realises the function (learned from its own text — validated
//              cells first), and decides what, if anything, needs asking.
//   questions  Jev questions about the SOURCE side: what the text obliges
//              ("does the speech end in this verse?"). What is obliged is
//              language-general; how the target realises it is not, which is
//              why plan() learns that from the project instead of assuming it.
//   findings   deterministic again: Jev's answers plus the plan become
//              exact-span suggestions.
//
// Alias-free so auth-worker and scripts/ can import it.

export type Metafunction = "textual" | "interpersonal" | "ideational"

/** One cell of the passage, in document order. */
export interface HarmonizerCell {
  id: string
  source: string
  target: string
  /** Verse reference or other locator, shown to Jev and in reasons. */
  ref?: string
  validated?: boolean
}

export interface JevNoul {
  type: "noul"
  instructions: Record<string, unknown>
  criteria?: { true: string; false: string }
}

export interface JevChoice {
  type: "choice"
  instructions: Record<string, unknown>
  criteria: Record<string, string>
}

export type HarmonizerQuestion = JevNoul | JevChoice

/** One exact-span suggestion. Offsets are into the cell's target text. */
export interface HarmonizerFinding {
  checkId: string
  metafunction: Metafunction
  cellId: string
  start: number
  end: number
  old: string
  new: string
  /** true: the span needs a person's (or a model's) rewording — there is no
   *  deterministic replacement, so the editor offers no Accept. `new === old`. */
  flagOnly?: boolean
  /** i18n key under `harmonizer.*` explaining the suggestion, plus its values. */
  reasonKey: string
  reasonValues: Record<string, string>
  /** Jev's probability for the decision behind this finding. */
  confidence: number
}

export interface HarmonyCheck<Plan> {
  id: string
  metafunction: Metafunction
  /** null = nothing in this passage needs asking. */
  plan(cells: readonly HarmonizerCell[]): Plan | null
  /** Question ids must start with `prefix` so checks share one request. */
  questions(plan: Plan, prefix: string): Record<string, HarmonizerQuestion>
  findings(
    plan: Plan,
    cells: readonly HarmonizerCell[],
    answers: Record<string, unknown>,
    prefix: string,
  ): HarmonizerFinding[]
}

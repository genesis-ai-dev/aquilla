/**
 * Terminology / Glossary data model.
 *
 * A Concept is a controlled-vocabulary entry: one source headword with one or
 * more target renderings each tagged preferred / admitted / forbidden.
 *
 * Active concepts are compiled to TranslationRule instances (derived on read)
 * and fed into the shared rule-engine violation surface — no materialized
 * verdicts are stored for terminology checks done via this path.
 */

import type { MessageKey } from "@/lib/i18n/messages/en"

export type RenderingStatus = "preferred" | "admitted" | "forbidden"

/**
 * `MessageKey` for a rendering status's display label — resolve with
 * `t(renderingStatusLabelKey(status))`. `RenderingStatus` itself (above) is
 * NEVER translated directly: rule compilation (compile.ts), sorting
 * (TermLookupPopover), and CSV/TBX status columns all compare against it as a
 * machine id, the same "canonical id vs. translated label" split
 * `roleName()`/`roleNameKey()` uses in `src/lib/frontier/roles.ts`.
 *
 * Consolidates what used to be six independently hand-copied
 * `Record<RenderingStatus, string>` maps (GlossaryRow, TerminologyTermDetail,
 * TerminologyMergeDialog, TerminologyReviewQueue, EquivalentsPanel,
 * TermLookupPopover) — one of which (TermLookupPopover) had drifted to
 * "avoid" for forbidden while the other five said "forbidden". None of the
 * six ever compared against the DISPLAY label (all switch on the
 * `RenderingStatus` machine id), so no comparison needed to move — only the
 * duplicated label maps needed consolidating.
 */
export function renderingStatusLabelKey(status: RenderingStatus): MessageKey {
  switch (status) {
    case "preferred":
      return "terminology.status.preferred"
    case "admitted":
      return "terminology.status.admitted"
    case "forbidden":
      return "terminology.status.forbidden"
  }
}

export interface TermRendering {
  rendering: string
  status: RenderingStatus
}

/**
 * Per-concept matching options. Every field is optional; absent fields resolve
 * to script- and project-derived defaults in `resolveMatchOptions`
 * (match-options.ts). Stored verbatim in `concepts.match_options`.
 */
export interface TermMatchOptions {
  /** Ignore combining marks (vowel points, accents) on both sides. */
  foldMarks?: boolean
  /** Allow the project's configured prefixes/suffixes around the term. */
  affixes?: boolean
  /** Extra literal source forms treated as alternates of sourceTerm. */
  forms?: string[]
  /** Matched surface forms the user rejected; compared after folding. */
  excludedForms?: string[]
}

/**
 * Project-level affix inventory for source-term matching. Plain data: the
 * matcher knows "prefix strings" and "suffix strings", nothing about any
 * language. Presets (affix-presets.ts) only pre-fill these lists.
 */
export interface TermMatchingSettings {
  prefixes: string[]
  suffixes: string[]
  /** Chained affixes allowed per side. Default 2. */
  maxAffixes?: number
  /** Overrides the script-derived foldMarks default for every concept. */
  foldMarksDefault?: boolean
}

export interface Concept {
  id: string
  /** Headword / lemma. Normalized exact match is case-insensitive. */
  sourceTerm: string
  renderings: TermRendering[]
  notes?: string
  status: "active" | "draft" | "deprecated"
  createdAt: string
  createdBy?: string
  updatedAt?: string
  /**
   * When true, source-term matching is case-sensitive. Omitted/false keeps the
   * default case-insensitive match used everywhere else in the term pipeline.
   */
  caseSensitive?: boolean
  /** Matching options; see TermMatchOptions. Absent = all defaults. */
  match?: TermMatchOptions
}

/** Payload from the editor "Add to terminology" popover. */
export interface ConceptDraft {
  sourceTerm: string
  rendering?: string
  caseSensitive?: boolean
  /**
   * True = add the concept ENFORCED (`status: 'active'`); false/absent = add it
   * as a SUGGESTION (`status: 'draft'`) for someone to review.
   *
   * The distinction is not cosmetic: a draft compiles to no rules at all
   * (see compileConceptsToRules), so it changes nothing for anyone else —
   * which is exactly why any contributor may write one, while approving takes
   * the org's configured termbase floor. The server enforces that split
   * independently (sync-worker termbase-authority.ts); this flag only decides
   * what the client ASKS for.
   */
  approve?: boolean
  match?: TermMatchOptions
}

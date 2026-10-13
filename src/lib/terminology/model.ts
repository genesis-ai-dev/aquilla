/**
 * Terminology data types with no UI or i18n imports.
 *
 * The matcher and the sync-worker occurrence query both import this module.
 * Keep it free of `@/` aliases so the worker bundle can follow the import
 * without pulling the SPA catalog in.
 */

export type RenderingStatus = "preferred" | "admitted" | "forbidden"

export interface TermRendering {
  rendering: string
  status: RenderingStatus
  /** `lanes.id`. Absent means the project's `legacy_tag === ''` lane. */
  laneId?: string
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

/** The fields the shared matcher reads. A full `Concept` satisfies this. */
export interface ConceptMatchInput {
  sourceTerm: string
  match?: TermMatchOptions
  caseSensitive?: boolean
  renderings?: TermRendering[]
}

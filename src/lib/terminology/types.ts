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

export type RenderingStatus = "preferred" | "admitted" | "forbidden"

export interface TermRendering {
  rendering: string
  status: RenderingStatus
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
}

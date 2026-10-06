// "Add to terminology" from Voices and Who's Who popovers (AQU-1693): what
// EditorTable hands the popovers, through BibleDataProvider.
//
// Null when the person can neither suggest nor link a term. The popovers
// themselves render only while Bible data shows (the experiment is on and a
// Bible is open), so this adds no gate of its own.

import { createContext } from "react"
import type { AcaiLabelLanguage } from "@/lib/bible-data/voice-labels"
import type { Concept, ConceptDraft, ConceptExternalIds, TermMatchingSettings } from "@/lib/terminology/types"

/** Link an existing concept to a Bible entity; `term` and `name` are for the toast. */
export interface EntityLinkRequest {
  conceptId: string
  externalIds: ConceptExternalIds
  term: string
  name: string
}

export interface EntityTermActions {
  concepts: readonly Concept[]
  termMatching?: TermMatchingSettings
  sourceLanguage: AcaiLabelLanguage | null
  /** Suggest a draft concept; null when the person may not. */
  add: ((draft: ConceptDraft) => void) | null
  /** Link an existing concept; null below the termbase floor. */
  link: ((request: EntityLinkRequest) => void) | null
}

export const EntityTermActionsContext = createContext<EntityTermActions | null>(null)

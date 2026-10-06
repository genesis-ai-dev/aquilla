// "Add to terminology" from a Voices or Who's Who popover (AQU-1693): what
// one click there may do for a participant, if anything.
//
//   • nothing, when a concept already links the participant (its name then
//     already comes from terminology, or waits for a suggestion's review), or
//     when the participant is a local one ACAI does not know (no stable id);
//   • link: an active concept already names the participant by headword but
//     is not linked. Linking is a term.update, which the server allows only
//     at the termbase floor, so only someone who can approve terms gets it;
//     anyone else gets nothing rather than a duplicate entry;
//   • add: no concept names the participant. One click suggests a draft
//     concept with the link and no rendering; its "View entry" toast opens it
//     to add the rendering.
//
// Pure.

import { conceptsNamed, type AcaiLabelLanguage } from "./voice-labels"
import type { BkpEntity } from "./pack-types"
import type { Concept, ConceptDraft, ConceptExternalIds, TermMatchingSettings } from "@/lib/terminology/types"

export type EntityTermAction =
  | { kind: "link"; concept: Concept; externalIds: ConceptExternalIds }
  | { kind: "add"; draft: ConceptDraft }

export interface EntityTermInputs {
  concepts: readonly Concept[]
  termMatching?: TermMatchingSettings
  /** The project's source language as a pack label key (`acaiLanguageFor`), or null. */
  sourceLanguage: AcaiLabelLanguage | null
  /** May suggest a term (a draft). */
  canAdd: boolean
  /** May link an existing term (the termbase floor). */
  canLink: boolean
  /** The lemma of the word that names the participant, from a mention: the headword in a Greek or Hebrew source. */
  lemma?: string
}

/** ACAI's disambiguator is not part of the name: "John (the Baptist)" → "John". */
function bareName(label: string | undefined): string {
  return (label ?? "").replace(/\s*\([^)]*\)\s*$/u, "").trim()
}

export function entityTermAction(entity: BkpEntity | undefined, inputs: EntityTermInputs): EntityTermAction | null {
  const acai = entity?.acai
  if (!entity || !acai) return null
  if (inputs.concepts.some((concept) => concept.externalIds?.acai === acai)) return null

  const sourceName = inputs.sourceLanguage ? bareName(entity.labels[inputs.sourceLanguage]) : ""
  const names = [sourceName, inputs.lemma?.trim() ?? ""].filter(Boolean)
  const named = names
    .flatMap((name) => conceptsNamed(name, inputs))
    .find((concept) => !concept.externalIds?.acai)
  if (named) return inputs.canLink ? { kind: "link", concept: named, externalIds: { acai } } : null

  if (!inputs.canAdd) return null
  const sourceTerm = sourceName || inputs.lemma?.trim() || bareName(entity.labels.eng)
  if (!sourceTerm) return null
  return { kind: "add", draft: { sourceTerm, externalIds: { acai } } }
}

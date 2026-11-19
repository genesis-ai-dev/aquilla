// Call site B of the per-lane orthography transform (AQU-2628): convert the
// model's output before the `ai_drafted` commit.
//
// WHY HERE AND NOT IN THE PROMPT. The run that justified this feature put the
// entire 2026 Uzbek alphabet in `translationInstructions`, confirmed it
// reached the model, and got 175 old-spelling forms back across 31 of 31
// verses — while the NAME list in the same prompt was followed perfectly.
// Spelling is not something a model can be asked for, so nothing here asks:
// the draft is converted on its way to the cell, deterministically.
//
// WHAT A READER OF THE HISTORY SEES. The raw model output is already recorded
// against the draft's `ai_interventions` row (AQU-1656, `interventionId`), and
// the cell gets the converted text, so Edit History holds both. The counts go
// on the provenance so the record says a conversion happened rather than
// leaving the difference to be inferred.
//
// WHAT THIS DOES NOT DO. It never converts a SOURCE cell, and it never runs
// for a project with no `orthography` block — `convertOrthography` is a no-op
// for a null profile, so the call is safe to make unconditionally and costs a
// null check in every other project.

import type { AiDraftProvenance } from "@/lib/sync/outbox-types"
import { convertOrthography, type OrthographyProfile } from "../../../db/shared/orthography"

/** The persistence snapshot a completion produces, as the commit sites hold it. */
export interface DraftSnapshot {
  value: string
  valueHtml?: string
}

export interface ConvertedDraft<T extends DraftSnapshot> {
  draft: T
  /** Absent when nothing was converted — no profile, or nothing to change. */
  stats?: { wordsConverted: number; exceptionsApplied: number }
}

/**
 * The lane's orthography applied to one drafted cell. Both the plain value and
 * the HTML snapshot go through, because either may be what the cell stores;
 * the converter leaves markup alone, so running it over HTML is safe.
 */
export function convertDraftOrthography<T extends DraftSnapshot>(
  draft: T,
  orthography: OrthographyProfile | null | undefined,
): ConvertedDraft<T> {
  if (!orthography) return { draft }
  const value = convertOrthography(draft.value, orthography)
  const html = draft.valueHtml === undefined ? null : convertOrthography(draft.valueHtml, orthography)
  const wordsConverted = value.wordsConverted + (html?.wordsConverted ?? 0)
  const exceptionsApplied = value.exceptionsApplied + (html?.exceptionsApplied ?? 0)
  const converted = {
    ...draft,
    value: value.text,
    ...(html ? { valueHtml: html.text } : {}),
  }
  return {
    draft: converted,
    ...(wordsConverted > 0 || exceptionsApplied > 0 ? { stats: { wordsConverted, exceptionsApplied } } : {}),
  }
}

/** The provenance to record for a draft, with the conversion noted when there was one. */
export function withOrthographyProvenance(
  provenance: AiDraftProvenance,
  stats: ConvertedDraft<DraftSnapshot>["stats"],
): AiDraftProvenance {
  return stats ? { ...provenance, orthography: stats } : provenance
}

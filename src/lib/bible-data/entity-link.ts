// Linking a terminology concept to a Bible entity (AQU-1693): which entities
// of one book's people layer Terminology's picker offers.
//
// Only entities ACAI knows can be linked: their id is stable across books and
// pack versions ("person:Jesus.2"). A local participant ("the Samaritan
// woman") has an id made from one word of one book, so it has no ACAI id and
// is not offered.
//
// Pure.

import { stripMarks } from "@/lib/terminology/match"
import type { BkpEntity, BkpEntityId } from "./pack-types"

export interface LinkCandidate {
  id: BkpEntityId
  /** The id a concept stores in `externalIds.acai`. */
  acai: string
  entity: BkpEntity
}

/** A name folded for comparison: no ACAI disambiguator ("John (the Baptist)" → "john"), no case, no marks. */
export function foldEntityName(value: string): string {
  return stripMarks(value.replace(/\s*\([^)]*\)\s*$/u, "").trim().toLocaleLowerCase())
}

/**
 * The book's linkable entities that match `query` (in any label language, or
 * by id). `suggested` are the ones a label of which is one of the concept's
 * `headwords` (its source term and forms); the rest follow in pack order.
 */
export function linkCandidates(
  entities: Readonly<Record<BkpEntityId, BkpEntity>>,
  headwords: readonly string[],
  query: string,
): { suggested: LinkCandidate[]; others: LinkCandidate[] } {
  const heads = new Set(headwords.map(foldEntityName).filter(Boolean))
  const wanted = foldEntityName(query)
  const suggested: LinkCandidate[] = []
  const others: LinkCandidate[] = []
  for (const [id, entity] of Object.entries(entities)) {
    if (!entity?.acai) continue
    const labels = Object.values(entity.labels ?? {})
      .filter((label): label is string => typeof label === "string")
      .map(foldEntityName)
    if (wanted && !labels.some((label) => label.includes(wanted)) && !entity.acai.toLowerCase().includes(wanted)) continue
    const candidate = { id, acai: entity.acai, entity }
    if (labels.some((label) => heads.has(label))) suggested.push(candidate)
    else others.push(candidate)
  }
  return { suggested, others }
}

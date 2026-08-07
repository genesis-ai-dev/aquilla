/**
 * Pure view-model helpers for the glossary editor surface.
 *
 * The editor shows one row per Concept: a source headword and a single
 * "primary" target rendering, with the full rendering set behind an expander.
 * These helpers derive/update that primary rendering and partition concepts by
 * lifecycle status. No side effects — callers persist via patchSettings.
 */
import { ROLE } from "@/lib/frontier/roles"
import type { Concept, TermRendering } from "./types"

/** The rendering shown in the row's target cell: first preferred, else first, else null. */
export function primaryRendering(concept: Concept): TermRendering | null {
  const preferred = concept.renderings.find((r) => r.status === "preferred")
  if (preferred) return preferred
  return concept.renderings[0] ?? null
}

/**
 * Update the primary rendering's text. Mutates the same rendering
 * `primaryRendering` would return: the first preferred, else the first, else
 * adds a new `preferred` rendering. Returns a new Concept (input unchanged).
 */
export function setPrimaryRendering(concept: Concept, text: string): Concept {
  const preferredIdx = concept.renderings.findIndex((r) => r.status === "preferred")
  const targetIdx = preferredIdx >= 0 ? preferredIdx : concept.renderings.length > 0 ? 0 : -1
  if (targetIdx === -1) {
    return { ...concept, renderings: [{ rendering: text, status: "preferred" }] }
  }
  return {
    ...concept,
    renderings: concept.renderings.map((r, i) =>
      i === targetIdx ? { ...r, rendering: text } : r,
    ),
  }
}

export interface GlossaryPartition {
  active: Concept[]
  suggested: Concept[]
  archived: Concept[]
}

/** Split concepts into lifecycle buckets, preserving order within each bucket. */
export function partitionConcepts(concepts: Concept[]): GlossaryPartition {
  const active: Concept[] = []
  const suggested: Concept[] = []
  const archived: Concept[] = []
  for (const concept of concepts) {
    if (concept.status === "active") active.push(concept)
    else if (concept.status === "draft") suggested.push(concept)
    else archived.push(concept)
  }
  return { active, suggested, archived }
}

/**
 * Level at which a user may manage termbase definitions.
 *
 * AQU-816: contributor (400), lowered from project_lead (500). Translators hold
 * the knowledge of what a term should render as, so they curate the term base
 * themselves; reviewer (300) and below stay read-only. This mirrors the
 * auth-worker gate — a term-base-only settings write needs contributor, every
 * other settings key still needs maintainer (600).
 */
const TERMBASE_EDIT_LEVEL = ROLE.CONTRIBUTOR

/**
 * May the user add/edit/delete/archive concepts? Local projects (no origin)
 * and not-yet-cached cloud roles are optimistically allowed; the server
 * enforces the real gate. Mirrors the rule previously local to TerminologyPage.
 */
export function canEditTermbase(
  syncRole?: { level: number } | null,
  hasOrigin?: boolean,
): boolean {
  if (!hasOrigin) return true
  if (!syncRole) return true
  return syncRole.level >= TERMBASE_EDIT_LEVEL
}

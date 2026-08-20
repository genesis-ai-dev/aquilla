/**
 * Pure view-model helpers for the glossary editor surface.
 *
 * The editor shows one row per Concept: a source headword and a single
 * "primary" target rendering, with the full rendering set behind an expander.
 * These helpers derive/update that primary rendering and partition concepts by
 * lifecycle status. No side effects — callers persist via patchSettings.
 */
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
 * Default level at which a user may manage termbase definitions, used when
 * the project's org hasn't configured a floor (AQU-822's
 * `termbaseEditMinRole`) or the server didn't send one.
 *
 * Mirrors DEFAULT_TERMBASE_EDIT_MIN_ROLE in
 * auth-worker/src/services/org-permissions.ts — keep the two in step.
 */
export const DEFAULT_TERMBASE_EDIT_MIN_ROLE = 500

/**
 * May the user add/edit/delete/archive concepts? Local projects (no origin)
 * and not-yet-cached cloud roles are optimistically allowed; the server
 * enforces the real gate. Mirrors the rule previously local to TerminologyPage.
 *
 * AQU-822: `minRole` is the org's configured termbase-edit floor
 * (`ProjectRecord.termbaseEditMinRole`), letting an org drop termbase
 * management to Contributor (400) — or raise it — without changing any other
 * project-settings permission. Omitted / out-of-ladder values fall back to the
 * PROJECT_LEAD default, so a misconfigured floor is a no-op rather than an
 * accidental open door.
 */
export function canEditTermbase(
  syncRole?: { level: number } | null,
  hasOrigin?: boolean,
  minRole?: number | null,
): boolean {
  if (!hasOrigin) return true
  if (!syncRole) return true
  return syncRole.level >= resolveTermbaseEditFloor(minRole)
}

/** Clamp an org-configured termbase floor to the role ladder, else the default. */
export function resolveTermbaseEditFloor(minRole?: number | null): number {
  if (typeof minRole !== "number" || !Number.isFinite(minRole)) {
    return DEFAULT_TERMBASE_EDIT_MIN_ROLE
  }
  if (minRole < 100 || minRole > 700) return DEFAULT_TERMBASE_EDIT_MIN_ROLE
  return minRole
}

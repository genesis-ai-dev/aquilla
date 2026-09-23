/**
 * Pure view-model helpers for the glossary editor surface.
 *
 * The editor shows one row per Concept: a source headword and a single
 * "primary" target rendering, with the full rendering set behind an expander.
 * These helpers derive/update that primary rendering and partition concepts by
 * lifecycle status. No side effects — callers persist via patchSettings.
 */
import { canPerform } from "@/lib/sync/role-policy"
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
 * May the user add/edit/delete/archive concepts? A role that isn't known yet
 * (record still loading, or a local project that never resolves one) is
 * optimistically allowed; the server enforces the real gate.
 *
 * AQU-208: a KNOWN role is always enforced. This used to short-circuit to
 * "allowed" for any record without `origin`, on the premise that no origin
 * meant a local project — but server-hydrated records never carry `origin`
 * (see `minimalProjectRecord`), so on the live surface every role, viewers
 * included, passed. `syncRole` is the cloud discriminator, the same one
 * `resolveEditorCapabilities` and `canPerform` key off.
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
  minRole?: number | null,
): boolean {
  if (!syncRole) return true
  return syncRole.level >= resolveTermbaseEditFloor(minRole)
}

/**
 * May the user SUGGEST a term — create one with `status: 'draft'`?
 *
 * AQU-872: terminology has TWO authority levels, not one (the split is spelled
 * out in sync-worker/src/events/termbase-authority.ts, which is what actually
 * enforces it). SUGGESTING is contributor work: a draft compiles to no rules
 * (compile.ts skips non-active concepts), so it binds nobody and needs no
 * manager. APPROVING one into force is management work and keeps the org's
 * configured floor — that question is `canEditTermbase` above.
 *
 * The in-editor "Add to terminology" popover already asked the two questions
 * separately; the Terminology page asked only the management one, so a
 * translator building a glossary as they worked found Add term disabled on the
 * very surface the glossary lives on.
 *
 * Keyed off the same role-policy mirror `canEditTermCells` uses — whose
 * `term.create` floor is CONTRIBUTOR — so this affordance cannot drift from the
 * table the outbox guard already applies, and it inherits the mirror's
 * fail-open rule: an unknown role is optimistically allowed and the server
 * stays authoritative.
 */
export function canSuggestTerm(syncRole?: { level: number } | null): boolean {
  return canPerform("term.create", syncRole?.level ?? null)
}

/**
 * May the user edit target cells from the C2 drill-down (AQU-208)?
 *
 * The drill-down's inline editor commits through `emitTargetCellCommit`, the
 * same path `EditorTable` uses, so it must ask the same question the editor
 * asks: `canPerform("target.cell.commit", …)`. Sharing the role-policy mirror
 * keeps the two surfaces from drifting when a floor moves, and inherits the
 * mirror's fail-open rule — an unknown role is optimistically allowed and the
 * server stays authoritative — which is also what `canEditTermbase` above
 * does. Like it, a known role is always enforced: there is no `origin`
 * escape hatch, which is what let a viewer open the inline editor.
 */
export function canEditTermCells(syncRole?: { level: number } | null): boolean {
  return canPerform("target.cell.commit", syncRole?.level ?? null)
}

/** Clamp an org-configured termbase floor to the role ladder, else the default. */
export function resolveTermbaseEditFloor(minRole?: number | null): number {
  if (typeof minRole !== "number" || !Number.isFinite(minRole)) {
    return DEFAULT_TERMBASE_EDIT_MIN_ROLE
  }
  if (minRole < 100 || minRole > 700) return DEFAULT_TERMBASE_EDIT_MIN_ROLE
  return minRole
}

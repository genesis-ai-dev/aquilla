// AQU-1006 follow-up: the glossary surface used to persist by PATCHing the
// whole `terminology` array back into the project-settings blob. Rewriting
// the array from a stale snapshot is how concurrent adds destroyed each other
// on 2026-09-04, and after the cutover the blob is no longer what anything
// reads — so a page that still wrote there showed its own edits and nothing
// else, while the editor (reading the projection) saw none of them.
//
// The pure store helpers still return the full next array; this module turns
// that into the smallest set of `term.*` events that takes the projection
// from `prev` to `next`. Every write lands in the outbox like any other event.
import type { Concept, TermRendering } from "./types"
import {
  emitTermApprove,
  emitTermCreate,
  emitTermDelete,
  emitTermReject,
  emitTermUpdate,
} from "@/lib/sync/events-emit"

export interface ConceptDeltaInput {
  projectId: string
  author: string
  /** The termbase as last known (server projection or prior optimistic state). */
  prev: Concept[]
  /** The termbase the caller wants. */
  next: Concept[]
}

function sameRenderings(a: TermRendering[], b: TermRendering[]): boolean {
  if (a.length !== b.length) return false
  return a.every((r, i) => r.rendering === b[i].rendering && r.status === b[i].status)
}

/**
 * Emit the `term.*` events that move the termbase from `prev` to `next`.
 * Resolves with the enqueued event ids, in emission order. Concepts are
 * matched by id; a concept only in `next` is a create, only in `prev` a
 * delete, and one in both is diffed field by field so an untouched concept
 * emits nothing.
 */
export async function emitConceptDelta({ projectId, author, prev, next }: ConceptDeltaInput): Promise<string[]> {
  const ids: string[] = []
  const before = new Map(prev.map((c) => [c.id, c]))
  const after = new Map(next.map((c) => [c.id, c]))

  for (const c of next) {
    const was = before.get(c.id)
    if (!was) {
      ids.push(
        await emitTermCreate({
          projectId,
          conceptId: c.id,
          sourceTerm: c.sourceTerm,
          renderings: c.renderings,
          status: c.status,
          ...(c.notes ? { notes: c.notes } : {}),
          ...(c.caseSensitive ? { caseSensitive: true } : {}),
          author,
        }),
      )
      continue
    }
    const update: Parameters<typeof emitTermUpdate>[0] = { projectId, conceptId: c.id, author }
    let changed = false
    if (c.sourceTerm !== was.sourceTerm) {
      update.sourceTerm = c.sourceTerm
      changed = true
    }
    if (!sameRenderings(c.renderings, was.renderings)) {
      update.renderings = c.renderings
      changed = true
    }
    if ((c.notes ?? "") !== (was.notes ?? "")) {
      // "" (not undefined) so the projector's COALESCE actually clears notes.
      update.notes = c.notes ?? ""
      changed = true
    }
    if (Boolean(c.caseSensitive) !== Boolean(was.caseSensitive)) {
      update.caseSensitive = Boolean(c.caseSensitive)
      changed = true
    }
    if (changed) ids.push(await emitTermUpdate(update))

    if (c.status !== was.status) {
      // Status is a lifecycle verb, not an updatable column: draft → active is
      // an approval, deprecated → active a restore (same event), anything →
      // deprecated an archive. active → draft has no verb; the projection
      // keeps the term active, which is the safe direction.
      if (c.status === "active") {
        ids.push(await emitTermApprove({ projectId, conceptId: c.id, author }))
      } else if (c.status === "deprecated") {
        ids.push(await emitTermReject({ projectId, conceptId: c.id, author, mode: "deprecate" }))
      }
    }
  }

  for (const c of prev) {
    if (!after.has(c.id)) ids.push(await emitTermDelete({ projectId, conceptId: c.id, author }))
  }
  return ids
}

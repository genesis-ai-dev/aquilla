/**
 * Terminology store helpers.
 *
 * All functions return the updated ProjectRecord so callers can immediately
 * persist it with patchProject / patchShared without a second read.
 *
 * Concepts are stored on ProjectRecord.terminology (an optional Concept[]).
 * Callers are responsible for persisting the returned record (e.g. via
 * patchProject + patchShared) — these helpers are pure (no side effects).
 */

import { v4 as uuid } from "uuid"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { Concept } from "./types"

// ---------------------------------------------------------------------------
// addConcept
// ---------------------------------------------------------------------------

/**
 * Add a new concept to the project.
 *
 * If `concept.id` is already provided it is preserved (useful when importing);
 * otherwise a fresh UUID is assigned. `createdAt` defaults to now.
 *
 * Returns the updated ProjectRecord.
 */
export function addConcept(
  project: ProjectRecord,
  concept: Omit<Concept, "id" | "createdAt"> & { id?: string; createdAt?: string },
): ProjectRecord {
  const now = new Date().toISOString()
  const newConcept: Concept = {
    ...concept,
    id: concept.id ?? uuid(),
    createdAt: concept.createdAt ?? now,
  }
  return {
    ...project,
    terminology: [...(project.terminology ?? []), newConcept],
  }
}

// ---------------------------------------------------------------------------
// updateConcept
// ---------------------------------------------------------------------------

/**
 * Apply a partial patch to an existing concept (matched by id).
 *
 * Always sets `updatedAt` to now.  No-op if the concept does not exist.
 *
 * Returns the updated ProjectRecord.
 */
export function updateConcept(
  project: ProjectRecord,
  id: string,
  patch: Partial<Omit<Concept, "id" | "createdAt">>,
): ProjectRecord {
  const now = new Date().toISOString()
  return {
    ...project,
    terminology: (project.terminology ?? []).map((c) =>
      c.id === id ? { ...c, ...patch, updatedAt: now } : c,
    ),
  }
}

// ---------------------------------------------------------------------------
// deleteConcept
// ---------------------------------------------------------------------------

/**
 * Remove a concept by id.
 *
 * Returns the updated ProjectRecord.
 */
export function deleteConcept(project: ProjectRecord, id: string): ProjectRecord {
  return {
    ...project,
    terminology: (project.terminology ?? []).filter((c) => c.id !== id),
  }
}

// ---------------------------------------------------------------------------
// mergeConcepts
// ---------------------------------------------------------------------------

/**
 * Merge two or more concepts into a single survivor.
 *
 * Rules:
 * - `survivorId` must be one of the `mergeIds`; it keeps its own id and createdAt.
 * - All renderings from merged-away concepts are union-merged into the survivor's
 *   renderings: a rendering is included once (case-insensitive dedup on `rendering`);
 *   when the same text appears in multiple concepts the survivor's own rendering
 *   entry wins, otherwise the first occurrence encountered wins.
 * - Notes are concatenated (survivor first, then others, separated by " | "), de-duped.
 * - Status: the survivor's status is preserved.
 * - Merged-away concepts (all in `mergeIds` except `survivorId`) are removed.
 * - `updatedAt` is set to now on the survivor.
 *
 * Throws if `survivorId` is not in `mergeIds`, or if any id in `mergeIds` does
 * not exist in the project, or if fewer than 2 ids are provided.
 */
export function mergeConcepts(
  project: ProjectRecord,
  mergeIds: string[],
  survivorId: string,
): ProjectRecord {
  if (mergeIds.length < 2) {
    throw new Error("mergeConcepts requires at least 2 concept ids.")
  }
  if (!mergeIds.includes(survivorId)) {
    throw new Error("survivorId must be one of the mergeIds.")
  }

  const all = project.terminology ?? []
  const toMerge = mergeIds.map((id) => {
    const c = all.find((x) => x.id === id)
    if (!c) throw new Error(`Concept ${id} not found.`)
    return c
  })

  const survivor = toMerge.find((c) => c.id === survivorId)!
  const others = toMerge.filter((c) => c.id !== survivorId)

  // Union-merge renderings: case-insensitive dedup, survivor wins on collision.
  const seen = new Map<string, import("./types").TermRendering>()
  for (const r of survivor.renderings) {
    seen.set(r.rendering.toLowerCase(), r)
  }
  for (const other of others) {
    for (const r of other.renderings) {
      const key = r.rendering.toLowerCase()
      if (!seen.has(key)) seen.set(key, r)
    }
  }
  const mergedRenderings = [...seen.values()]

  // Merge notes: concat unique, survivor first.
  const notesParts: string[] = []
  const seenNotes = new Set<string>()
  for (const c of [survivor, ...others]) {
    const n = c.notes?.trim()
    if (n && !seenNotes.has(n)) {
      seenNotes.add(n)
      notesParts.push(n)
    }
  }
  const mergedNotes = notesParts.length > 0 ? notesParts.join(" | ") : undefined

  const now = new Date().toISOString()
  const mergedSurvivor = {
    ...survivor,
    renderings: mergedRenderings,
    notes: mergedNotes,
    updatedAt: now,
  }

  const mergeIdSet = new Set(mergeIds)
  const nextTerminology = all
    .filter((c) => !mergeIdSet.has(c.id) || c.id === survivorId)
    .map((c) => (c.id === survivorId ? mergedSurvivor : c))

  return { ...project, terminology: nextTerminology }
}

// ---------------------------------------------------------------------------
// approveConcept / rejectConcept (review-queue helpers)
// ---------------------------------------------------------------------------

/**
 * Approve a draft concept: set status to "active".
 * No-op if it doesn't exist or is already active.
 */
export function approveConcept(project: ProjectRecord, id: string): ProjectRecord {
  return updateConcept(project, id, { status: "active" })
}

/**
 * Reject a draft concept.
 *
 * mode="delete" — removes it entirely (default).
 * mode="deprecate" — sets status to "deprecated" (keeps history).
 */
export function rejectConcept(
  project: ProjectRecord,
  id: string,
  mode: "delete" | "deprecate" = "delete",
): ProjectRecord {
  if (mode === "deprecate") return updateConcept(project, id, { status: "deprecated" })
  return deleteConcept(project, id)
}

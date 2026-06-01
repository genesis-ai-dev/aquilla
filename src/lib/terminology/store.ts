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

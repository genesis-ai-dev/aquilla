// AQU-2305: who may bring a NEW source file into ONE project — the org's
// import floor (AQU-2304), which a project may make STRICTER and never looser.
//
// The org keeps `importMinRole` in its settings blob (Project lead when unset,
// AQU-2304). A project may store the same key in its own settings blob. The
// floor a project enforces is the HIGHER of the two, so a project value at or
// below the org's is inert: one written before the org raised its floor, or one
// that reached the blob around the settings route, can never open an import the
// org closed.
//
// Decision (Matthew, 2026-10-30): stricter-only, not a free override. A
// project's settings are maintainer-writable while the org's floor is
// owner-only, so a free override would let a project maintainer undo an
// owner's policy.
//
// The stricter-only arithmetic is the same as the roster/member-progress
// visibility floors (./visibility-floors.ts) — only the key and the org-side
// default differ — so this module borrows `stricterProjectFloor` rather than
// restating it. Shared by both workers so the auth-worker's settings response
// and the sync-worker's `file.create` perimeter can never disagree about the
// floor one project enforces.

import { stricterProjectFloor } from "./visibility-floors"

/** The settings key, the same one the org uses (AQU-2304). */
export const IMPORT_MIN_ROLE_KEY = "importMinRole"

/**
 * The project's own value where STRICTER than the org's, else null ("follows
 * the organization"). Null is what the Project Settings row renders as
 * "Organization default (…)", so an inert stored value must read as null here
 * and not as "this project set its own".
 */
export function stricterProjectImportFloor(orgFloor: number, projectRaw: unknown): number | null {
  return stricterProjectFloor(orgFloor, projectRaw)
}

/** The floor a project enforces: the org's, raised by the project's own value. */
export function effectiveImportFloor(orgFloor: number, projectRaw: unknown): number {
  return stricterProjectImportFloor(orgFloor, projectRaw) ?? orgFloor
}

/** One project's import floor as every surface reports it. */
export interface ImportFloorView {
  /** The org's floor, defaults applied. */
  org: number
  /** The project's own value where stricter, else null. */
  project: number | null
  /** The floor actually enforced — the higher of the two. */
  effective: number
}

export function importFloorView(orgFloor: number, projectRaw: unknown): ImportFloorView {
  const project = stricterProjectImportFloor(orgFloor, projectRaw)
  return { org: orgFloor, project, effective: project ?? orgFloor }
}

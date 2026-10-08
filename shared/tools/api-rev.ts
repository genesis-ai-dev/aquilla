/**
 * Smart Extensions bridge API revisions.
 *
 * TOOLS_API_REV (manifest.ts) is the revision the host speaks today; a tool
 * records the revision it was built against. When a bridge call is removed,
 * bump TOOLS_API_REV, add a marker here, and raise TOOLS_MIN_API_REV if old
 * tools can no longer work. The in-frame runtime keeps a stub for every
 * removed call, and the host answers it with `api_removed` naming the
 * replacement — so an old extension fails loudly with a fix, and the host
 * offers "this extension is old → rebuild" (an edit_tool run carrying the
 * migration notes below).
 */

import { TOOLS_API_REV } from "./manifest"

/** Oldest revision the host still runs without the "rebuild" banner. */
export const TOOLS_MIN_API_REV = 1

export interface RemovedApi {
  /** Bridge method, e.g. "cells.save". */
  method: string
  /** First apiRev without it. */
  removedIn: number
  replacement: string
}

/** Removed-API markers. `cells.save` was the pre-release name of
 *  `cells.commit` (single edit, not batched); it is kept as the first marker
 *  so the mechanism is exercised end to end. */
export const REMOVED_APIS: readonly RemovedApi[] = [
  { method: "cells.save", removedIn: 1, replacement: "aquilla.cells.commit([{ fileId, cellId, value }])" },
]

export function removedApi(method: string): RemovedApi | null {
  return REMOVED_APIS.find((r) => r.method === method) ?? null
}

export function isToolStale(apiRev: number): boolean {
  return apiRev < TOOLS_MIN_API_REV || apiRev > TOOLS_API_REV
}

/** The instruction a "rebuild" sends to the builder (edit_tool). */
export function rebuildRequest(apiRev: number, extraFailure?: string): string {
  const removed = REMOVED_APIS.filter((r) => r.removedIn > apiRev || extraFailure?.includes(r.method))
  return [
    `Update this extension to the current aquilla bridge API (apiRev ${TOOLS_API_REV}); it was built for apiRev ${apiRev}.`,
    ...removed.map((r) => `- aquilla.${r.method} was removed in apiRev ${r.removedIn}; use ${r.replacement}.`),
    extraFailure ? `It failed at runtime with: ${extraFailure}` : "",
    "Keep its behaviour and UI otherwise unchanged.",
  ]
    .filter(Boolean)
    .join("\n")
}

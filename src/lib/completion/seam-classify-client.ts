// Client for POST /api/v1/ai/seams/classify (AQU-1386).
//
// Thin on purpose: the route already answers 200-with-heuristics on every
// degraded path, so there is almost nothing for this layer to recover from.
// What it does add is the last backstop — a network error or a malformed body
// resolves to an empty result rather than rejecting, because the caller
// (ensureSeamsForFile) is a background job and `draftingUnitsFor` is already
// correct with no answers at all.

import { AUTH_BASE } from "@/lib/frontier/auth"
import type { SeamWindowCell } from "./seam-request"
import type { ClassifiedSeam } from "./seam-store"

export const SEAM_CLASSIFY_URL = `${AUTH_BASE}/api/v1/ai/seams/classify`

function isClassifiedSeam(v: unknown): v is ClassifiedSeam {
  if (!v || typeof v !== "object") return false
  const s = v as Record<string, unknown>
  return (
    typeof s.join === "boolean"
    && typeof s.joinProbability === "number"
    && typeof s.prevCellId === "string"
    && typeof s.nextCellId === "string"
  )
}

export interface SeamClassifyOptions {
  identityToken: string
  projectId: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/**
 * Classify one window of cells. Returns [] on any failure — never throws, so a
 * background classification pass cannot surface an error to a translator who
 * did not ask for one.
 */
export async function classifySeamWindow(
  window: SeamWindowCell[],
  options: SeamClassifyOptions,
): Promise<ClassifiedSeam[]> {
  if (window.length < 2) return []
  try {
    const response = await (options.fetchImpl ?? fetch)(SEAM_CLASSIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.identityToken}`,
      },
      body: JSON.stringify({ projectId: options.projectId, cells: window }),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (!response.ok) return []
    const body = await response.json() as { seams?: unknown }
    if (!Array.isArray(body.seams)) return []
    return body.seams.filter(isClassifiedSeam)
  } catch {
    return []
  }
}

// AQU-1573: the SPA's reads of the reference Bibles installed on the server
// (auth-worker/src/routes/reference-bibles.ts).
//
// Kept out of src/lib/reference-bible/ on purpose: that folder is the
// alias-free core both workers import, and this file is browser-only.

import { AUTH_BASE } from "./auth"
import type { ReferenceBibleSummary, ReferencePassage } from "../reference-bible/types"

export interface ReferencePassagesResult {
  version: ReferenceBibleSummary
  passages: ReferencePassage[]
  /** Requested references this Bible has no verses for. */
  unresolved: string[]
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body.error === "string") return body.error
  } catch {
    // Non-JSON body: the status line is all there is.
  }
  return `HTTP ${res.status}`
}

/** Every Bible installed on the server, by language then name. */
export async function fetchReferenceBibles(jwt: string): Promise<ReferenceBibleSummary[]> {
  const res = await fetch(`${AUTH_BASE}/api/v2/reference-bibles`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) throw new Error(await readError(res))
  const body = (await res.json()) as { versions?: ReferenceBibleSummary[] }
  return Array.isArray(body.versions) ? body.versions : []
}

/**
 * The verses of canonical references ("ISA 40:25") in one Bible. Null when the
 * Bible is not installed (404), so a caller can draft without the block rather
 * than fail.
 */
export async function fetchReferencePassages(
  jwt: string,
  versionId: string,
  refs: readonly string[],
): Promise<ReferencePassagesResult | null> {
  const res = await fetch(`${AUTH_BASE}/api/v2/reference-bibles/${encodeURIComponent(versionId)}/passages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ refs }),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(await readError(res))
  return (await res.json()) as ReferencePassagesResult
}

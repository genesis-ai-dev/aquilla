// Cache key half #2: a digest of WHAT the user asked for. Together with the
// freshness key (what the project currently contains) it decides whether a
// cached per-project export can be reused. `useCache` is excluded — toggling
// the reuse checkbox must not invalidate the thing it wants to reuse.

import type { EgressOptions } from "./types"

/**
 * Folded into every options hash so bumping it invalidates EVERY cached
 * per-project zip at once. Bump when an engine fix changes the bytes produced
 * for identical inputs — v2: the zero-audio fix (pre-v2 zips were assembled
 * from cells that never carried attachments, so audio modes cached empty).
 */
export const EGRESS_ENGINE_VERSION = 2

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")
}

/** Deterministic JSON: object keys sorted recursively, arrays kept in order.
 *  Callers pre-sort arrays that are semantically sets (lanes, fileIds). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/**
 * sha256 hex of the canonical JSON of (options minus useCache, sorted selected
 * fileIds for one project). Lanes are sorted too — lane checkbox order changes
 * zip entry order, not content, so it must not force a rebuild.
 */
export async function computeOptionsHash(
  options: EgressOptions,
  selectedFileIds: readonly string[],
): Promise<string> {
  const { useCache: _useCache, ...rest } = options
  const payload = {
    engineVersion: EGRESS_ENGINE_VERSION,
    options: { ...rest, lanes: [...rest.lanes].sort() },
    fileIds: [...selectedFileIds].sort(),
  }
  return sha256Hex(new TextEncoder().encode(canonicalJson(payload)))
}

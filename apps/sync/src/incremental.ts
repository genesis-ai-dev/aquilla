// Incremental-diff encoding for the sync-worker's onSave path. Replaces the
// earlier "write full state on every save" approach that caused DO isolate
// OOMs once R2 accumulated ~dozens of multi-MB tail objects for a single
// file. Pure (no R2/DO coupling) so it unit-tests against Y.Doc directly.

import * as Y from "yjs"

export interface TailEncoding {
  /** Bytes to persist as the next tail object. */
  update: Uint8Array
  /** State vector to stash for the next call. Pass back as `lastFlushedSV`
   *  on the subsequent onSave so we emit only what's new since this write. */
  newSV: Uint8Array
}

/**
 * Encode the next tail to write:
 * - On the first call (no prior state vector) — full state dump.
 * - On subsequent calls — only the delta since `lastFlushedSV`.
 * - Returns null when the doc hasn't advanced, so the caller skips the R2 write.
 *
 * Seeding `lastFlushedSV` from the doc's current state vector at the end of
 * `onLoad` prevents a post-cold-start regression where the first incremental
 * save would redundantly re-emit the full replayed state as a new tail.
 */
export function encodeNextTail(
  doc: Y.Doc,
  lastFlushedSV: Uint8Array | null
): TailEncoding | null {
  const currentSV = Y.encodeStateVector(doc)
  if (lastFlushedSV && bytesEqual(lastFlushedSV, currentSV)) return null
  const update = lastFlushedSV
    ? Y.encodeStateAsUpdate(doc, lastFlushedSV)
    : Y.encodeStateAsUpdate(doc)
  return { update, newSV: currentSV }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

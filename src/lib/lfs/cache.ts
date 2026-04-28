// src/lib/lfs/cache.ts
// OPFS-backed blob cache keyed on LFS oid. Lives at /lfs-cache/<first2>/<oid>,
// separate from repo dirs so it survives re-imports and isn't part of any git
// working tree. Sharded on first 2 hex chars so single dirs stay small.

import { createOpfsFs, type OpfsFs } from "@/lib/git/opfs-fs"
import { markOpfsUnavailable } from "@/lib/storage/opfs-availability"

let rootFsCache: OpfsFs | null = null

// Returns null when OPFS is unavailable (e.g. Safari Private Browsing). The
// LFS download path still works without a cache — we just refetch each time.
async function rootFs(): Promise<OpfsFs | null> {
  if (rootFsCache) return rootFsCache
  try {
    const handle = await navigator.storage?.getDirectory?.()
    if (!handle) {
      markOpfsUnavailable()
      return null
    }
    rootFsCache = createOpfsFs(handle)
    return rootFsCache
  } catch {
    markOpfsUnavailable()
    return null
  }
}

/** Test seam — inject a memory-backed fs instead of navigator.storage. */
export function __setRootForTests(fs: OpfsFs | null): void {
  rootFsCache = fs
}

function cachePath(oid: string): string {
  return `/lfs-cache/${oid.slice(0, 2)}/${oid}`
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("")
}

export async function lfsCacheGet(oid: string): Promise<Uint8Array | null> {
  const fs = await rootFs()
  if (!fs) return null
  try {
    const bytes = await fs.promises.readFile(cachePath(oid))
    return typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
  } catch {
    return null
  }
}

export async function lfsCachePut(oid: string, bytes: Uint8Array): Promise<void> {
  const actual = await sha256Hex(bytes)
  if (actual !== oid.toLowerCase()) {
    throw new Error(
      `LFS cache integrity mismatch: expected oid ${oid.slice(0, 12)}..., got ${actual.slice(0, 12)}...`,
    )
  }
  const fs = await rootFs()
  if (!fs) return
  await fs.promises.writeFile(cachePath(oid), bytes)
}

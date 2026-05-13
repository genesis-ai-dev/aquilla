// OPFS-backed cache of decoded waveform peaks keyed by audioId. Peaks are
// stored as raw Float32 little-endian bytes (4 bytes per bin). Sharded by the
// first two characters of the sanitized id so individual directories stay
// small as the cache grows.

import { createOpfsFs, type OpfsFs } from "@/lib/fs/opfs-fs"
import { markOpfsUnavailable } from "@/lib/storage/opfs-availability"

let rootFsCache: OpfsFs | null = null

// Returns null when OPFS is unavailable (Safari Private Browsing, locked-down
// contexts). Callers must treat null as "no cache" rather than an error so the
// audio stack can still stream and decode without persistence.
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

export function __setRootForTests(fs: OpfsFs | null): void {
  rootFsCache = fs
}

function sanitize(audioId: string): string {
  return audioId.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function cachePath(audioId: string, bins: number): string {
  const safe = sanitize(audioId)
  const shard = safe.length >= 2 ? safe.slice(0, 2) : "__"
  return `/audio-peaks/${shard}/${safe}.${bins}.f32`
}

export async function peaksCacheGet(
  audioId: string,
  bins: number,
): Promise<Float32Array | null> {
  const fs = await rootFs()
  if (!fs) return null
  try {
    const data = await fs.promises.readFile(cachePath(audioId, bins))
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
    if (bytes.byteLength !== bins * 4) return null
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  } catch {
    return null
  }
}

export async function peaksCachePut(
  audioId: string,
  peaks: Float32Array,
): Promise<void> {
  const fs = await rootFs()
  if (!fs) return
  const view = new Uint8Array(peaks.buffer, peaks.byteOffset, peaks.byteLength)
  await fs.promises.writeFile(cachePath(audioId, peaks.length), view)
}

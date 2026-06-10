// OPFS-backed L2 cache for audio bytes, keyed by audioId.
//
// Audio recordings are IMMUTABLE: a new recording always gets a new audioId,
// so cached bytes are permanently valid and never need revalidation. The
// per-component `bytesRef` in useCellAudio is the L1 (avoids async churn in
// render); this module is the L2 that survives across component remounts,
// tab-switches, and browser sessions.
//
// Layout (one file per recording):
//   /audio-bytes/<shard>/<sanitized-audioId>.<ext>
// where <shard> = first two chars of the sanitized id to keep directory
// entry counts small (mirrors the peaks-cache layout).
//
// LRU eviction: an index file (/audio-bytes/index.json) stores the ordered
// list of cached entries (oldest-first) and their byte sizes. When the total
// exceeds MAX_TOTAL_BYTES the oldest entries are deleted first. JSON is small
// relative to the audio blobs, so the sync write is acceptable.
//
// CONSTRAINT: ~200 MB cap. A typical recording is 100–800 KB; 200 MB holds
// ~250–2000 recordings without noticeable disk impact.

import { createOpfsFs, type OpfsFs } from "@/lib/fs/opfs-fs"
import { markOpfsUnavailable } from "@/lib/storage/opfs-availability"

const MAX_TOTAL_BYTES = 200 * 1024 * 1024 // 200 MB

/** Exposed for tests. */
export const AUDIO_BYTES_DIR = "/audio-bytes"
const INDEX_PATH = `${AUDIO_BYTES_DIR}/index.json`

interface IndexEntry {
  audioId: string
  ext: string
  sizeBytes: number
  /** ISO timestamp of the last access (read or write). Used for LRU ordering. */
  lastAccessedAt: string
}

interface CacheIndex {
  entries: IndexEntry[]
  totalBytes: number
}

let rootFsCache: OpfsFs | null = null

// Returns null when OPFS is unavailable. Callers must treat null as "no
// cache" — audio still works, just without persistent byte caching.
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

/** @internal — test seam; replaces the OPFS root without touching navigator. */
export function __setRootForTests(fs: OpfsFs | null): void {
  rootFsCache = fs
}

function sanitize(audioId: string): string {
  return audioId.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function bytesPath(audioId: string, ext: string): string {
  const safe = sanitize(audioId)
  const shard = safe.length >= 2 ? safe.slice(0, 2) : "__"
  return `${AUDIO_BYTES_DIR}/${shard}/${safe}.${ext}`
}

// ── Index helpers ─────────────────────────────────────────────────────────────

async function readIndex(fs: OpfsFs): Promise<CacheIndex> {
  try {
    const raw = await fs.promises.readFile(INDEX_PATH)
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
    const parsed = JSON.parse(text) as CacheIndex
    // Basic validation — if the shape is wrong, reset.
    if (!Array.isArray(parsed.entries) || typeof parsed.totalBytes !== "number") {
      return { entries: [], totalBytes: 0 }
    }
    return parsed
  } catch {
    // File not yet written (first run) or corrupt — start fresh.
    return { entries: [], totalBytes: 0 }
  }
}

async function writeIndex(fs: OpfsFs, index: CacheIndex): Promise<void> {
  const raw = new TextEncoder().encode(JSON.stringify(index))
  await fs.promises.writeFile(INDEX_PATH, raw)
}

// ── Eviction ──────────────────────────────────────────────────────────────────

async function evictIfNeeded(fs: OpfsFs, index: CacheIndex): Promise<void> {
  if (index.totalBytes <= MAX_TOTAL_BYTES) return
  // Sort entries oldest-last (we shift from the front).
  // The list is already maintained in insertion/access order (oldest first).
  while (index.totalBytes > MAX_TOTAL_BYTES && index.entries.length > 0) {
    const oldest = index.entries.shift()!
    try {
      await fs.promises.unlink(bytesPath(oldest.audioId, oldest.ext))
    } catch {
      // File may already be gone — ignore.
    }
    index.totalBytes = Math.max(0, index.totalBytes - oldest.sizeBytes)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up cached audio bytes by audioId + extension.
 * Returns `null` on a miss or when OPFS is unavailable.
 */
export async function audioCacheGet(
  audioId: string,
  ext: string,
): Promise<Uint8Array | null> {
  const fs = await rootFs()
  if (!fs) return null
  try {
    const raw = await fs.promises.readFile(bytesPath(audioId, ext))
    const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw
    if (bytes.byteLength === 0) return null

    // Update LRU: bump lastAccessedAt and move entry to the end (most recent).
    const index = await readIndex(fs)
    const idx = index.entries.findIndex((e) => e.audioId === audioId && e.ext === ext)
    if (idx !== -1) {
      const [entry] = index.entries.splice(idx, 1)
      entry.lastAccessedAt = new Date().toISOString()
      index.entries.push(entry)
      await writeIndex(fs, index).catch(() => { /* non-fatal */ })
    }
    return bytes
  } catch {
    return null
  }
}

/**
 * Store audio bytes for a given audioId + extension.
 * Silently no-ops when OPFS is unavailable or when the write fails.
 * Also evicts oldest entries if the cache exceeds MAX_TOTAL_BYTES.
 */
export async function audioCachePut(
  audioId: string,
  ext: string,
  bytes: Uint8Array,
): Promise<void> {
  const fs = await rootFs()
  if (!fs) return
  try {
    await fs.promises.writeFile(bytesPath(audioId, ext), bytes)
    const index = await readIndex(fs)

    // Remove any existing entry for this audioId (e.g. overwritten recording
    // with the same id is extremely unlikely given UUIDv7 audioIds, but be safe).
    const existing = index.entries.findIndex((e) => e.audioId === audioId && e.ext === ext)
    if (existing !== -1) {
      const [old] = index.entries.splice(existing, 1)
      index.totalBytes = Math.max(0, index.totalBytes - old.sizeBytes)
    }

    index.entries.push({
      audioId,
      ext,
      sizeBytes: bytes.byteLength,
      lastAccessedAt: new Date().toISOString(),
    })
    index.totalBytes += bytes.byteLength

    await evictIfNeeded(fs, index)
    await writeIndex(fs, index)
  } catch {
    // Non-fatal: the audio stack still works without the persistent cache.
  }
}

/**
 * Remove a specific audioId from the cache (called when the recording is
 * deleted so subsequent opens don't serve stale bytes from a re-used key —
 * unlikely with UUIDv7 ids but included for correctness).
 */
export async function audioCacheEvict(audioId: string, ext: string): Promise<void> {
  const fs = await rootFs()
  if (!fs) return
  try {
    await fs.promises.unlink(bytesPath(audioId, ext)).catch(() => { /* already gone */ })
    const index = await readIndex(fs)
    const idx = index.entries.findIndex((e) => e.audioId === audioId && e.ext === ext)
    if (idx !== -1) {
      const [entry] = index.entries.splice(idx, 1)
      index.totalBytes = Math.max(0, index.totalBytes - entry.sizeBytes)
      await writeIndex(fs, index)
    }
  } catch {
    // Best-effort.
  }
}

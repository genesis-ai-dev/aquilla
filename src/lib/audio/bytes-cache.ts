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

// Smooth-playback round: the budget adapts to what the browser actually
// grants. 200 MB was a fixed courtesy constant; browsers typically grant an
// origin gigabytes (Chrome: up to ~60% of free disk), and a whole project's
// dubs only stay warm if they fit. Floor 200 MB (estimate() missing or
// stingy), ceiling ~1.5 GB, never more than a fifth of the granted quota.
const FLOOR_BYTES = 200 * 1024 * 1024
const CEILING_BYTES = 1536 * 1024 * 1024
const QUOTA_FRACTION = 0.2

let budgetCache: number | null = null

/** The cache's byte budget for this session (resolved once, then memoized). */
export async function audioCacheBudget(): Promise<number> {
  if (budgetCache != null) return budgetCache
  let budget = FLOOR_BYTES
  try {
    const est = await navigator.storage?.estimate?.()
    const quota = est?.quota
    if (typeof quota === "number" && Number.isFinite(quota) && quota > 0) {
      budget = Math.min(CEILING_BYTES, Math.max(FLOOR_BYTES, Math.floor(quota * QUOTA_FRACTION)))
    }
  } catch {
    /* keep the floor */
  }
  budgetCache = budget
  return budget
}

/** @internal — test seam for the adaptive budget. */
export function __setBudgetForTests(bytes: number | null): void {
  budgetCache = bytes
}

/** Exposed for tests. */
export const AUDIO_BYTES_DIR = "/audio-bytes"
const INDEX_PATH = `${AUDIO_BYTES_DIR}/index.json`

interface IndexEntry {
  audioId: string
  ext: string
  sizeBytes: number
  // FORTIFY: the old lastAccessedAt field was written on every get/put but
  // never read — LRU truth is (and always was) the ARRAY ORDER, oldest first.
  // Two encodings of recency where only one is real was a maintenance trap;
  // stale copies in existing index files parse fine and are simply ignored.
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
  __resetAudioCacheMemo() // a fresh fs must not inherit the old fs's index
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

// ── Serialized, memoized index (fortify round) ───────────────────────────────
// Every index operation used to be an unserialized read-modify-write of the
// whole JSON file. The warmer's own two workers (and playback's write-through,
// and LRU bumps) routinely interleaved: both read v0, both wrote, one PUT was
// LOST — bytes sat on disk unindexed, invisible to `has`, uncountable by the
// budget, unevictable forever. It also parsed the entire index once per
// operation (hundreds of parses per warm sweep). Now: one in-memory index,
// loaded once, every mutation funneled through a promise chain, written
// through. Cross-tab remains last-write-wins — a second tab can still clobber
// the file, which is an accepted (and now documented) residual; the in-tab
// races that actually occurred constantly are gone.

let memoIndex: CacheIndex | null = null
let indexChain: Promise<unknown> = Promise.resolve()

function withIndex<T>(op: (fs: OpfsFs, index: CacheIndex) => Promise<T>): Promise<T | null> {
  const run = indexChain.then(async (): Promise<T | null> => {
    const fs = await rootFs()
    if (!fs) return null
    if (!memoIndex) memoIndex = await readIndex(fs)
    return op(fs, memoIndex)
  })
  indexChain = run.catch(() => {})
  return run.catch(() => null)
}

/** True when the byte cache can actually persist anything this session. The
 *  warmer checks this first — without it, an OPFS-less session (private
 *  browsing) re-downloaded a whole file's clips every lens entry and stored
 *  none of them. */
export async function audioCacheAvailable(): Promise<boolean> {
  return (await rootFs()) != null
}

/** @internal — sign-out purge + tests: drop all in-memory index state so a
 *  wiped directory can't be resurrected from the memo. */
export function __resetAudioCacheMemo(): void {
  memoIndex = null
  indexChain = Promise.resolve()
}

/** @internal — tests: await every queued index operation (fire-and-forget
 *  write-throughs land behind the serialization chain). */
export function __flushAudioCacheForTests(): Promise<void> {
  return indexChain.then(() => undefined)
}

// ── Eviction ──────────────────────────────────────────────────────────────────

async function evictIfNeeded(fs: OpfsFs, index: CacheIndex): Promise<void> {
  const budget = await audioCacheBudget()
  if (index.totalBytes <= budget) return
  // Sort entries oldest-last (we shift from the front).
  // The list is already maintained in insertion/access order (oldest first).
  while (index.totalBytes > budget && index.entries.length > 0) {
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

    // LRU bump: move the entry to the end (most recent) — serialized so it
    // can't race a concurrent put into losing an entry.
    void withIndex(async (fsi, index) => {
      const idx = index.entries.findIndex((e) => e.audioId === audioId && e.ext === ext)
      if (idx !== -1) {
        const [entry] = index.entries.splice(idx, 1)
        index.entries.push(entry)
        await writeIndex(fsi, index).catch(() => { /* non-fatal */ })
      }
    })
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
  await withIndex(async (fs, index) => {
    try {
      await fs.promises.writeFile(bytesPath(audioId, ext), bytes)

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
      })
      index.totalBytes += bytes.byteLength

      await evictIfNeeded(fs, index)
      await writeIndex(fs, index)
    } catch {
      // Non-fatal: the audio stack still works without the persistent cache.
    }
  })
}

/**
 * Convenience wrapper: cache a recording straight from its Blob (record-time
 * producers hold a Blob, not a Uint8Array). Warming the cache here lets a take
 * be transcribed/played locally before — or without — a successful R2 upload
 * (FRO-355). Non-fatal on any failure.
 */
export async function audioCachePutBlob(
  audioId: string,
  ext: string,
  blob: Blob,
): Promise<void> {
  try {
    await audioCachePut(audioId, ext, new Uint8Array(await blob.arrayBuffer()))
  } catch {
    // Non-fatal — the audio stack still works without the persistent cache.
  }
}

/**
 * Remove a specific audioId from the cache (called when the recording is
 * deleted so subsequent opens don't serve stale bytes from a re-used key —
 * unlikely with UUIDv7 ids but included for correctness).
 */
/**
 * Cheap existence check — the warmer's "already stocked?" question. Reads only
 * the index (no bytes into memory) and deliberately does NOT bump LRU: merely
 * planning a warm sweep must not reorder eviction against clips someone is
 * actually listening to.
 */
export async function audioCacheHas(audioId: string, ext: string): Promise<boolean> {
  const found = await withIndex(async (_fs, index) =>
    index.entries.some((e) => e.audioId === audioId && e.ext === ext),
  )
  return found ?? false
}

/** Current cache occupancy in bytes (index-only read). */
export async function audioCacheUsage(): Promise<number> {
  const usage = await withIndex(async (_fs, index) => index.totalBytes)
  return usage ?? 0
}

export async function audioCacheEvict(audioId: string, ext: string): Promise<void> {
  await withIndex(async (fs, index) => {
    try {
      await fs.promises.unlink(bytesPath(audioId, ext)).catch(() => { /* already gone */ })
      const idx = index.entries.findIndex((e) => e.audioId === audioId && e.ext === ext)
      if (idx !== -1) {
        const [entry] = index.entries.splice(idx, 1)
        index.totalBytes = Math.max(0, index.totalBytes - entry.sizeBytes)
        await writeIndex(fs, index)
      }
    } catch {
      // Best-effort.
    }
  })
}

// AQU-1573: the open file's cited verses, from the active lane's reference
// Bible, for the copilot's drafting block and the live quote check.
//
// A sermon cell that says "Isaiah 40:25 says, …" must be drafted with the
// wording of the Bible the lane quotes from (Van Dyck for LOTE's Arabic). The
// verses live on the server (auth-worker /api/v2/reference-bibles), so this
// hook keeps a module-level cache — Bible id → canonical reference → passage —
// and fills it in ONE batched request per change of the open file, 300 ms
// after the cells settle. Drafting then reads from the cache (fetching only
// what is still missing), and the quote check reads it synchronously.
//
// Nothing here ever blocks a draft: a lane with no Bible, a source with no
// references, a Bible the server does not have, or a failed lookup all mean
// "no block". useCompletion catches a rejected lookup and drafts without it.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import { effectiveSourceText, type SourceTextCell } from "@/lib/cell-text"
import { buildReferenceVersesBlock } from "@/lib/completion/prompt-build"
import { fetchReferencePassages } from "@/lib/frontier/reference-bibles"
import { findScriptureReferences, uniqueReferences } from "@/lib/reference-bible/reference-finder"
import type { ReferenceQuoteLookup } from "@/lib/reference-bible/quote-check"
import type { FoundReference, ReferenceBibleSummary, ReferencePassage } from "@/lib/reference-bible/types"

/** References one passages request carries (the route's cap). */
const REFS_PER_REQUEST = 200
/** Source texts whose references are remembered before the memo is reset. */
const MAX_MEMO_TEXTS = 20_000
const PREFETCH_DELAY_MS = 300
/**
 * How long a "this Bible is not installed" answer is trusted. Not forever: a
 * tester who loads the Bibles (or a preview database that gets them later)
 * should see verses in the same tab without a reload (review 2026-10-02).
 */
export const NOT_INSTALLED_RETRY_MS = 30_000

interface VersionCache {
  /** undefined = not asked yet; null = the server does not have this Bible. */
  version: ReferenceBibleSummary | null | undefined
  /** When the server last said it does not have this Bible (Date.now()). */
  notInstalledAt: number
  /** canonical → passage, or null when this Bible has no such verse. */
  passages: Map<string, ReferencePassage | null>
  inflight: Map<string, Promise<void>>
  /** Bumped whenever something new lands, so the quote check re-runs once. */
  revision: number
  listeners: Set<() => void>
}

const caches = new Map<string, VersionCache>()
const referencesByText = new Map<string, FoundReference[]>()

function cacheFor(versionId: string): VersionCache {
  let cache = caches.get(versionId)
  if (!cache) {
    cache = { version: undefined, notInstalledAt: 0, passages: new Map(), inflight: new Map(), revision: 0, listeners: new Set() }
    caches.set(versionId, cache)
  }
  return cache
}

function bump(cache: VersionCache): void {
  cache.revision += 1
  for (const listener of cache.listeners) listener()
}

/** The explicit references in one source text, memoised per text (keystrokes stay cheap). */
export function cachedReferences(text: string): FoundReference[] {
  let found = referencesByText.get(text)
  if (!found) {
    if (referencesByText.size >= MAX_MEMO_TEXTS) referencesByText.clear()
    found = findScriptureReferences(text)
    referencesByText.set(text, found)
  }
  return found
}

/**
 * Distinct canonical references the cells' sources cite, in document order,
 * and which of them the finder cut short ("Psalm 119:1-176" → PSA 119:1-30):
 * the server returns a complete 30-verse range for those, so the cut has to
 * be carried to the block from here.
 */
function canonicalsFor(cells: readonly SourceTextCell[]): { canonicals: string[]; cut: Set<string> } {
  const seen = new Set<string>()
  const canonicals: string[] = []
  const cut = new Set<string>()
  for (const cell of cells) {
    const text = effectiveSourceText(cell)
    if (!text || !/\d/.test(text)) continue
    for (const f of uniqueReferences(cachedReferences(text))) {
      if (f.truncated) cut.add(f.canonical)
      if (seen.has(f.canonical)) continue
      seen.add(f.canonical)
      canonicals.push(f.canonical)
    }
  }
  return { canonicals, cut }
}

/** Fetch whatever of `canonicals` this Bible's cache lacks; waits for in-flight ones. */
async function loadCanonicals(jwt: string, versionId: string, canonicals: readonly string[]): Promise<void> {
  const cache = cacheFor(versionId)
  if (cache.version === null && Date.now() - cache.notInstalledAt < NOT_INSTALLED_RETRY_MS) return
  const waits: Promise<void>[] = []
  const missing: string[] = []
  for (const canonical of canonicals) {
    if (cache.passages.has(canonical)) continue
    const pending = cache.inflight.get(canonical)
    if (pending) waits.push(pending)
    else missing.push(canonical)
  }
  for (let i = 0; i < missing.length; i += REFS_PER_REQUEST) {
    const batch = missing.slice(i, i + REFS_PER_REQUEST)
    const request = fetchReferencePassages(jwt, versionId, batch).then((result) => {
      if (!result) {
        cache.version = null
        cache.notInstalledAt = Date.now()
      } else {
        cache.version = result.version
        for (const passage of result.passages) cache.passages.set(passage.canonical, passage)
        for (const canonical of result.unresolved) cache.passages.set(canonical, null)
      }
      bump(cache)
    })
    // A failed request is not remembered: the next draft or prefetch retries.
    const settled = request.finally(() => {
      for (const canonical of batch) cache.inflight.delete(canonical)
    })
    for (const canonical of batch) cache.inflight.set(canonical, settled)
    waits.push(settled)
  }
  await Promise.all(waits)
}

/** The quote check's view of one Bible: its name and a synchronous verse lookup. */
export interface ReferenceBibleCheckContext {
  versionId: string
  versionName: string
  lookup: ReferenceQuoteLookup
  /** The explicit references in a source text, memoised per text. */
  references: (source: string) => readonly FoundReference[]
  /** How many times the cache has filled in; a new value means new verses. */
  revision: number
}

/** The check context for a Bible as its cache stands now, or null before the server described it. */
function checkContextFor(versionId: string): ReferenceBibleCheckContext | null {
  const cache = cacheFor(versionId)
  if (!cache.version) return null
  const passages = cache.passages
  return {
    versionId,
    versionName: cache.version.name,
    lookup: (canonical) => passages.get(canonical)?.verses.map((v) => v.text),
    references: cachedReferences,
    revision: cache.revision,
  }
}

export interface UseReferenceBibleOptions {
  /** Session JWT; without one nothing is fetched. */
  jwt: string | null | undefined
  /** The active lane's Bible id (referenceBibleForLane), or null for none. */
  versionId: string | null
  /** The open file's cells (prefetch scans their sources). */
  getCells: () => readonly SourceTextCell[]
  /** Anything that changes when the open file's cells do (the store version). */
  cellsVersion: unknown
}

export interface UseReferenceBibleResult {
  /** The lane's Bible once the server has described it; null before or without one. */
  version: ReferenceBibleSummary | null
  /** The reference-verses block for one drafting call, or undefined for none. */
  blockFor: (cells: readonly SourceTextCell[]) => Promise<string | undefined>
  /** Make sure every verse the cells cite is in the cache (Check file awaits it). */
  ensureLoaded: (cells: readonly SourceTextCell[]) => Promise<void>
  /** Null until the Bible is known; changes identity only when `sig` does. */
  checkContext: ReferenceBibleCheckContext | null
  /**
   * The check context as the cache stands at call time. Check file awaits
   * `ensureLoaded` and then reads this, because the render-time
   * `checkContext` it closed over may predate the Bible being known.
   */
  currentCheckContext: () => ReferenceBibleCheckContext | null
  /** Changes whenever new verses arrive or the Bible changes. */
  sig: string
}

const noopSubscribe = () => () => {}

export function useReferenceBible(options: UseReferenceBibleOptions): UseReferenceBibleResult {
  const { jwt, versionId, getCells, cellsVersion } = options
  const cache = versionId ? cacheFor(versionId) : null

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!cache) return noopSubscribe()
      cache.listeners.add(listener)
      return () => {
        cache.listeners.delete(listener)
      }
    },
    [cache],
  )
  const revision = useSyncExternalStore(subscribe, () => cache?.revision ?? 0, () => 0)

  const ensureLoaded = useCallback(
    async (cells: readonly SourceTextCell[]) => {
      if (!jwt || !versionId) return
      const { canonicals } = canonicalsFor(cells)
      if (canonicals.length > 0) await loadCanonicals(jwt, versionId, canonicals)
    },
    [jwt, versionId],
  )

  const blockFor = useCallback(
    async (cells: readonly SourceTextCell[]) => {
      if (!jwt || !versionId) return undefined
      const { canonicals, cut } = canonicalsFor(cells)
      if (canonicals.length === 0) return undefined
      await loadCanonicals(jwt, versionId, canonicals)
      const loaded = cacheFor(versionId)
      if (!loaded.version) return undefined
      const passages = canonicals
        .map((canonical) => loaded.passages.get(canonical))
        .filter((p): p is ReferencePassage => !!p)
        .map((p) => (cut.has(p.canonical) && !p.truncated ? { ...p, truncated: true } : p))
      return (
        buildReferenceVersesBlock({
          versionName: loaded.version.name,
          languageName: loaded.version.languageName,
          passages,
        }) || undefined
      )
    },
    [jwt, versionId],
  )

  // Prefetch the open file's references once its cells settle, so the first
  // sparkle does not wait on the network and the quote check has its verses.
  useEffect(() => {
    if (!jwt || !versionId) return
    const timer = setTimeout(() => {
      ensureLoaded(getCells()).catch((err: unknown) => {
        console.warn("[useReferenceBible] prefetch failed:", err)
      })
    }, PREFETCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [jwt, versionId, cellsVersion, getCells, ensureLoaded])

  const version = cache?.version ?? null
  const sig = versionId ? `${versionId}:${version ? "ready" : "none"}:${revision}` : ""
  // The cache's maps mutate in place, so a new context object (carrying the
  // new revision) is what tells the quote check to re-run.
  const checkContext = useMemo<ReferenceBibleCheckContext | null>(() => {
    if (!versionId || !version) return null
    const ctx = checkContextFor(versionId)
    return ctx && { ...ctx, revision }
  }, [versionId, version, revision])
  const currentCheckContext = useCallback(
    () => (versionId ? checkContextFor(versionId) : null),
    [versionId],
  )

  return { version, blockFor, ensureLoaded, checkContext, currentCheckContext, sig }
}

/** TEST-ONLY: forget every cached Bible and reference. */
export function resetReferenceBibleCacheForTests(): void {
  caches.clear()
  referencesByText.clear()
}

// Bible Knowledge Pack client (AQU-1686).
//
// The pack is static, versioned JSON that bibletranslation.org publishes:
// `{base}/manifest.json` and one file per layer and book,
// `{base}/{layer}/{BOOK}.json` (contract: bible-wiki
// pipeline/src/schemas/bkp.ts, mirrored in ./pack-types.ts). This client:
//
//   • fetches through the same-origin resource proxy
//     (src/lib/net/resource-proxy.ts), which is a no-op unless
//     VITE_RESOURCES_BASE is set, as for Parallel Bibles;
//   • caches every file in memory (one promise per file per session) and in
//     IndexedDB (./pack-store.ts), keyed `${version}/${layer}/${book}`. The
//     version comes from the manifest, which is revalidated once per session,
//     so a new pack version misses both caches. Layer URLs carry `?v=` so an
//     HTTP cache cannot answer for a new version with an old file either;
//   • loads only the layers a project's enabled enrichments need, and nothing
//     at all while Bible data is off;
//   • never throws into the UI: an unreachable, missing or malformed file is
//     a typed `{ ok: false, reason }`. A failure is not remembered, so the
//     next call retries.

import { proxiedFetch } from "@/lib/net/resource-proxy"
import { projectHasScriptureFiles, type FileReference } from "@/lib/parsers/types"
import {
  layersForEnrichments,
  resolveBibleEnrichments,
  type BibleDataSettings,
  type BkpLayer,
} from "../../../db/shared/bible-enrichments"
import { parseLayer, parseManifest, type BkpLayerData, type BkpManifest } from "./pack-types"
import {
  MANIFEST_RECORD_KEY,
  packFileKey,
  prunePackRecords,
  readPackRecord,
  writePackRecord,
} from "./pack-store"
import { isBibleDataExperimentOn } from "./experiment"
import { mapLayerToProject } from "./versification"

export const DEFAULT_BKP_BASE = "https://bibletranslation.org/bkp/v1"

/** `VITE_BKP_BASE`, else the published pack. No trailing slash. */
export function bkpBase(): string {
  const configured = (import.meta.env.VITE_BKP_BASE as string | undefined)?.trim()
  return (configured || DEFAULT_BKP_BASE).replace(/\/+$/, "")
}

/**
 * Why a file did not load:
 *   offline   — not reachable now (no network, a network error, a server
 *               error) and not cached; a later call retries;
 *   not-found — the pack does not have it (no such book or layer, or 404);
 *   invalid   — the file arrived but is not what the contract says.
 */
export type BkpFailureReason = "offline" | "not-found" | "invalid"

export type BkpResult<T> = { ok: true; value: T } | { ok: false; reason: BkpFailureReason }

type Fetched = { ok: true; json: unknown } | { ok: false; reason: BkpFailureReason }

async function fetchJson(url: string, init?: RequestInit): Promise<Fetched> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { ok: false, reason: "offline" }
  }
  let response: Response
  try {
    response = await proxiedFetch(url, init)
  } catch {
    // Network failure, DNS, or a CORS refusal: all look like "unreachable".
    return { ok: false, reason: "offline" }
  }
  if (!response.ok) {
    const unavailable = response.status >= 500 || response.status === 429
    return { ok: false, reason: unavailable ? "offline" : "not-found" }
  }
  try {
    return { ok: true, json: await response.json() }
  } catch (err) {
    // Bad JSON is the file's fault; a body cut off by the network is not.
    return { ok: false, reason: err instanceof SyntaxError ? "invalid" : "offline" }
  }
}

// ── Manifest ────────────────────────────────────────────────────────────────

/** Remembered for the session only after a successful network read. */
let manifestFromNetwork: BkpResult<BkpManifest> | null = null
let manifestInFlight: Promise<BkpResult<BkpManifest>> | null = null

async function readManifest(): Promise<{ result: BkpResult<BkpManifest>; fromNetwork: boolean }> {
  // `no-cache` revalidates with the server, so a new pack version is seen.
  const fetched = await fetchJson(`${bkpBase()}/manifest.json`, { cache: "no-cache" })
  if (fetched.ok) {
    const manifest = parseManifest(fetched.json)
    if (!manifest) return { result: { ok: false, reason: "invalid" }, fromNetwork: true }
    await writePackRecord({ key: MANIFEST_RECORD_KEY, version: manifest.version, data: manifest, storedAt: Date.now() })
    await prunePackRecords(manifest.version)
    return { result: { ok: true, value: manifest }, fromNetwork: true }
  }
  if (fetched.reason !== "offline") return { result: fetched, fromNetwork: true }
  // Unreachable: the last manifest seen online keeps the cached layers usable.
  const cached = parseManifest((await readPackRecord(MANIFEST_RECORD_KEY))?.data)
  return {
    result: cached ? { ok: true, value: cached } : { ok: false, reason: "offline" },
    fromNetwork: false,
  }
}

/** The pack manifest: once per session from the network, else the last one cached. */
export function loadManifest(): Promise<BkpResult<BkpManifest>> {
  if (manifestFromNetwork) return Promise.resolve(manifestFromNetwork)
  if (!manifestInFlight) {
    manifestInFlight = readManifest()
      // Nothing above should throw; if it does, it is still not the UI's problem.
      .catch(() => ({ result: { ok: false, reason: "offline" } as const, fromNetwork: false }))
      .then(({ result, fromNetwork }) => {
        manifestInFlight = null
        if (fromNetwork && result.ok) manifestFromNetwork = result
        return result
      })
  }
  return manifestInFlight
}

// ── Layers ──────────────────────────────────────────────────────────────────

const layerPromises = new Map<string, Promise<BkpResult<BkpLayerData[BkpLayer]>>>()

async function readLayer<L extends BkpLayer>(
  layer: L,
  book: string,
  version: string,
): Promise<BkpResult<BkpLayerData[L]>> {
  const key = packFileKey(version, layer, book)
  const stored = parseLayer(layer, book, (await readPackRecord(key))?.data)
  if (stored) return { ok: true, value: stored }
  const url = `${bkpBase()}/${layer}/${encodeURIComponent(book)}.json?v=${encodeURIComponent(version)}`
  const fetched = await fetchJson(url)
  if (!fetched.ok) return fetched
  const data = parseLayer(layer, book, fetched.json)
  if (!data) return { ok: false, reason: "invalid" }
  await writePackRecord({ key, version, data, storedAt: Date.now() })
  return { ok: true, value: data }
}

/** One layer of one book (`book` is a USFM code such as "JHN"), in ORG versification. */
export async function loadLayer<L extends BkpLayer>(layer: L, book: string): Promise<BkpResult<BkpLayerData[L]>> {
  const manifest = await loadManifest()
  if (!manifest.ok) return manifest
  const { version, books } = manifest.value
  // Own keys only: "toString" or "__proto__" is not a book.
  const entry = Object.hasOwn(books, book) ? books[book] : undefined
  if (!entry?.layers.includes(layer)) return { ok: false, reason: "not-found" }

  const key = packFileKey(version, layer, book)
  let pending = layerPromises.get(key) as Promise<BkpResult<BkpLayerData[L]>> | undefined
  if (!pending) {
    // e.g. encodeURIComponent on a malformed version string: still a typed result.
    const started = readLayer(layer, book, version).catch(
      (): BkpResult<BkpLayerData[L]> => ({ ok: false, reason: "invalid" }),
    )
    pending = started
    layerPromises.set(key, started)
    void started.then((result) => {
      if (!result.ok && layerPromises.get(key) === started) layerPromises.delete(key)
    })
  }
  return pending
}

// ── Enabled layers for a project ────────────────────────────────────────────

/** What the loader reads from a project. A ProjectRecord fits. */
export interface BibleDataProject extends BibleDataSettings {
  files?: Pick<FileReference, "type" | "hasScriptureContent">[]
  /** Device-local experiment switches; Bible data loads only with `bibleData` on. */
  experimentalFlags?: Record<string, boolean>
}

/** One result per layer the project's enabled enrichments need, in its versification. */
export type BkpEnabledLayers = { [L in BkpLayer]?: BkpResult<BkpLayerData[L]> }

/**
 * The layers that `project`'s enabled enrichments need for `book`, and only
 * those. With the Bible data experiment off on this device, Bible data off, or
 * every enrichment off, nothing is fetched, not even the manifest.
 */
export async function loadEnabledLayers(project: BibleDataProject, book: string): Promise<BkpEnabledLayers> {
  if (!isBibleDataExperimentOn(project)) return {}
  const enabled = resolveBibleEnrichments(project, projectHasScriptureFiles(project.files))
  const entries = await Promise.all(
    layersForEnrichments(enabled).map(async (layer) => {
      const result = await loadLayer(layer, book)
      return [layer, result.ok ? { ok: true, value: mapLayerToProject(result.value) } : result] as const
    }),
  )
  // Each entry pairs a layer with that layer's own result.
  return Object.fromEntries(entries) as BkpEnabledLayers
}

/** Test seam: forget the session's memory caches, as a reload would. IndexedDB stays. */
export function __resetBkpMemoryCache(): void {
  manifestFromNetwork = null
  manifestInFlight = null
  layerPromises.clear()
}

/**
 * aquifer/passage-resources.ts — verse-scoped "enhanced resources" (AQU-461).
 *
 * The Aquifer corpus (bibletranslation.org) publishes a page per verse at
 * `/en/passages/{BOOK}/{chapter}/{verse}/` whose tail carries an
 * "Entities in this Passage" section — the people, places, terms, flora/fauna
 * and so on that the verse mentions, each linking to its own entity page. Place
 * pages in turn carry a **Coordinates:** line, which is what lets us draw a map
 * beside the verse.
 *
 * Until now that data only reached the agent (and the Search dock's free-text
 * reader). This module is the reading half of the sidebar surface: pure parsers
 * over the markdown the existing gated `/api/v1/aquifer/page` route already
 * returns, plus promise-caches so scrolling back over a verse costs no request.
 *
 * No new server route: everything here goes through `aquiferReadPage`, so the
 * `bibleResourcesEnabled` project gate, the worker-side host allowlist and the
 * Workers Cache API all still apply exactly as they do for the Search dock.
 *
 * Maps are drawn as a mosaic of OpenStreetMap raster tiles (plain `<img>`, no
 * map library and no iframe) so the tile URLs can ride the AQU-627 same-origin
 * resource proxy like every other third-party content fetch in the SPA.
 */

import { aquiferReadPage, type AquiferPageResponse } from "./client"
import { proxyOrigin } from "@/lib/net/resource-proxy"

// ── Types ───────────────────────────────────────────────────────────────────

/** One entity the passage page links to, as listed in "Entities in this Passage". */
export interface AquiferEntityRef {
  /** Display name, e.g. "Bethlehem (of Judah)". */
  title: string
  /** Site-relative page path, e.g. "/en/places/bethlehem/". */
  path: string
  /** Entity kind as the page states it, e.g. "place", "person", "term". */
  kind: string
}

export interface AquiferCoordinates {
  lat: number
  lon: number
}

/** The renderable parts of one entity page. */
export interface AquiferEntityDetail {
  /** Absolute page URL, for the "open externally" affordance. */
  url: string
  /** One-line gloss from the top of the page, when it has one. */
  summary: string | null
  /** Present for places that publish a location — this is what draws the map. */
  coordinates: AquiferCoordinates | null
  /** First inline image on the page, absolutized. Null for every entity kind
   *  today — the corpus publishes no per-entity imagery yet — so this is the
   *  seam that lights up on its own the day it does. */
  image: { url: string; alt: string } | null
}

// ── Ref → passage path ──────────────────────────────────────────────────────

/**
 * Map a canonical ref ("RUT 1:8") to its Aquifer passage path
 * ("/en/passages/RUT/1/8/"). Returns null when the ref isn't `BOOK ch:vs` —
 * chapter-scoped and heading refs have no verse page.
 */
export function passagePathFromRef(canonicalRef: string): string | null {
  const m = /^([A-Z0-9]{2,4})\s+(\d+):(\d+)/.exec(canonicalRef.trim().toUpperCase())
  if (!m) return null
  const [, book, chapter, verse] = m
  return `/en/passages/${book}/${chapter}/${verse}/`
}

// ── Parsers (pure) ──────────────────────────────────────────────────────────

/** Heading that opens the entity list on a passage page. */
const ENTITIES_HEADING = /^#{2,6}\s+Entities in this Passage\s*$/i
/** `- [Bethlehem (of Judah)](/en/places/bethlehem/) (place)` */
const ENTITY_LINE = /^\s*[-*]\s+\[(.+?)\]\((\/[^)]+)\)\s*(?:\(([^)]+)\))?\s*$/

/**
 * Extract the entity list from a passage page's markdown.
 *
 * Scans from the "Entities in this Passage" heading to the next heading of the
 * same-or-shallower level, so a later "## Translation Questions" section ends
 * the list rather than bleeding into it. Returns `[]` when the section is
 * absent — most non-narrative verses have no entities, and a truncated page
 * loses the section entirely (it sits at the very end).
 */
export function parsePassageEntities(markdown: string): AquiferEntityRef[] {
  const lines = markdown.split("\n")
  const start = lines.findIndex((line) => ENTITIES_HEADING.test(line))
  if (start === -1) return []

  const headingDepth = (lines[start].match(/^#+/)?.[0].length ?? 2)
  const out: AquiferEntityRef[] = []
  const seen = new Set<string>()

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    const nextHeading = /^(#+)\s/.exec(line)
    if (nextHeading && nextHeading[1].length <= headingDepth) break
    const m = ENTITY_LINE.exec(line)
    if (!m) continue
    const [, title, path, kind] = m
    if (seen.has(path)) continue
    seen.add(path)
    out.push({
      title: title.trim(),
      path: path.trim(),
      kind: (kind ?? kindFromPath(path) ?? "").trim().toLowerCase(),
    })
  }
  return out
}

/** Fall back to the URL segment when a line omits its trailing "(kind)". */
function kindFromPath(path: string): string | null {
  // "/en/places/bethlehem/" → "places" → "place"
  const m = /^\/[a-z-]+\/([a-z-]+)\//i.exec(path)
  if (!m) return null
  return m[1].replace(/s$/, "")
}

/** `mlat=31.705&mlon=35.210` inside the page's OpenStreetMap link. */
const OSM_LINK_COORDS = /[?&]mlat=(-?\d+(?:\.\d+)?)&mlon=(-?\d+(?:\.\d+)?)/
/** `**Coordinates:** [31.7054°, 35.2103°]` — used when the link form is absent. */
const LABEL_COORDS = /Coordinates:\*{0,2}\s*\[?\s*(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)\s*°?/i

/**
 * Pull a place's latitude/longitude out of its entity page. Prefers the
 * OpenStreetMap link (full precision) and falls back to the rounded label.
 * Returns null when the page publishes no location, or when the numbers are
 * out of range — a malformed page must not put a marker on the map.
 */
export function parseEntityCoordinates(markdown: string): AquiferCoordinates | null {
  const m = OSM_LINK_COORDS.exec(markdown) ?? LABEL_COORDS.exec(markdown)
  if (!m) return null
  const lat = Number(m[1])
  const lon = Number(m[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return null
  return { lat, lon }
}

/** `![alt](src)` — markdown image, the only image form the API can emit. */
const MD_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/

/**
 * First inline image on an entity page, resolved against the page's own URL so
 * a site-relative `src` becomes fetchable. Only http(s) survives — a `data:`
 * or `javascript:` src from upstream content is dropped rather than rendered.
 */
export function parseEntityImage(
  markdown: string,
  pageUrl: string,
): { url: string; alt: string } | null {
  const m = MD_IMAGE.exec(markdown)
  if (!m) return null
  let resolved: URL
  try {
    resolved = new URL(m[2], pageUrl)
  } catch {
    return null
  }
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return null
  return { url: resolved.toString(), alt: m[1].trim() }
}

/**
 * The one-line gloss under an entity page's H1 — the first plain prose line,
 * skipping the title, the bare type word ("City", "Mammals") and the bolded
 * metadata rows ("**Region of:** …"). Null when the page opens straight into a
 * section heading.
 */
export function parseEntitySummary(markdown: string): string | null {
  const lines = markdown.split("\n")
  let sawTitle = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^#+\s/.test(line)) {
      if (sawTitle) return null // reached the first section without prose
      sawTitle = true
      continue
    }
    if (!sawTitle) continue
    if (line.startsWith("**")) continue // metadata row
    if (line.length < 12) continue // the bare type word ("City", "Mammals")
    return line
  }
  return null
}

// ── OpenStreetMap tile mosaic ───────────────────────────────────────────────

/** Tile pixel size of the OSM raster layer. */
export const OSM_TILE_SIZE = 256
/** Regional framing — enough context to place a town without naming a street. */
export const DEFAULT_MAP_ZOOM = 7

const OSM_TILE_ORIGIN = proxyOrigin("https://tile.openstreetmap.org")

/** Web-Mercator fractional tile coordinates for a point at `zoom`. */
export function coordsToTilePoint(
  { lat, lon }: AquiferCoordinates,
  zoom: number,
): { x: number; y: number } {
  const n = 2 ** zoom
  const latRad = (lat * Math.PI) / 180
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  }
}

export interface MapTile {
  /** Tile image URL (proxied when `VITE_RESOURCES_BASE` is configured). */
  url: string
  /** Offset within the viewport, in CSS pixels. */
  left: number
  top: number
}

export interface MapMosaic {
  tiles: MapTile[]
  /** Marker position within the viewport, in CSS pixels. */
  marker: { left: number; top: number }
}

/**
 * The tiles that cover a `width`×`height` viewport centred on `coords`, each
 * with its offset — enough to render a static map as absolutely-positioned
 * `<img>` elements, with no map library and no third-party script.
 *
 * Tiles outside the pyramid (past the poles, or off the antimeridian) are
 * dropped rather than requested, so the mosaic degrades to blank space at the
 * edges of the world instead of 404-ing.
 */
export function buildMapMosaic(
  coords: AquiferCoordinates,
  width: number,
  height: number,
  zoom: number = DEFAULT_MAP_ZOOM,
): MapMosaic {
  const n = 2 ** zoom
  const point = coordsToTilePoint(coords, zoom)
  // World-pixel coordinate of the viewport's top-left corner.
  const originX = point.x * OSM_TILE_SIZE - width / 2
  const originY = point.y * OSM_TILE_SIZE - height / 2

  const firstX = Math.floor(originX / OSM_TILE_SIZE)
  const lastX = Math.floor((originX + width - 1) / OSM_TILE_SIZE)
  const firstY = Math.floor(originY / OSM_TILE_SIZE)
  const lastY = Math.floor((originY + height - 1) / OSM_TILE_SIZE)

  const tiles: MapTile[] = []
  for (let ty = firstY; ty <= lastY; ty++) {
    if (ty < 0 || ty >= n) continue
    for (let tx = firstX; tx <= lastX; tx++) {
      if (tx < 0 || tx >= n) continue
      tiles.push({
        url: `${OSM_TILE_ORIGIN}/${zoom}/${tx}/${ty}.png`,
        left: tx * OSM_TILE_SIZE - originX,
        top: ty * OSM_TILE_SIZE - originY,
      })
    }
  }
  return { tiles, marker: { left: width / 2, top: height / 2 } }
}

/** Human-facing OpenStreetMap permalink for a location (opened on click only). */
export function osmPermalink(
  { lat, lon }: AquiferCoordinates,
  zoom: number = DEFAULT_MAP_ZOOM,
): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${zoom}/${lat}/${lon}`
}

/** "31.705°N, 35.210°E" — a readable, direction-bearing coordinate label. */
export function formatCoordinates({ lat, lon }: AquiferCoordinates): string {
  const ns = lat >= 0 ? "N" : "S"
  const ew = lon >= 0 ? "E" : "W"
  return `${Math.abs(lat).toFixed(3)}°${ns}, ${Math.abs(lon).toFixed(3)}°${ew}`
}

// ── Fetching (promise-cached) ───────────────────────────────────────────────

/**
 * Passage pages run ~10 KB; the entity list is the LAST section, so a low
 * `maxChars` would silently drop exactly the part this sidebar reads. Ask for
 * the worker's ceiling.
 */
const PAGE_MAX_CHARS = 50_000

/** Entity pages are read only for their header (gloss, coordinates, image). */
const ENTITY_MAX_CHARS = 4_000

/** Cap the entity pages fetched per verse — a busy narrative verse can list a
 *  dozen, and each is an upstream round-trip. */
export const MAX_DETAIL_LOOKUPS = 8

const passageCache = new Map<string, Promise<AquiferEntityRef[]>>()
const detailCache = new Map<string, Promise<AquiferEntityDetail>>()

/** Prefer the markdown body; `text` is the same content under the legacy key. */
function pageBody(page: AquiferPageResponse): string {
  return page.markdown ?? page.text ?? ""
}

/**
 * Entities mentioned by one verse. Promise-cached per path for the life of the
 * tab, so scrolling back up a chapter re-renders from memory.
 *
 * A rejected fetch is evicted so the next visit retries rather than caching the
 * failure forever.
 */
export function loadPassageEntities(
  jwt: string,
  projectId: string,
  passagePath: string,
): Promise<AquiferEntityRef[]> {
  const cached = passageCache.get(passagePath)
  if (cached) return cached
  const promise = aquiferReadPage(jwt, projectId, passagePath, { maxChars: PAGE_MAX_CHARS })
    .then((page) => parsePassageEntities(pageBody(page)))
    .catch((err) => {
      passageCache.delete(passagePath)
      throw err
    })
  passageCache.set(passagePath, promise)
  return promise
}

/** One entity page's renderable header. Cached and evicted like the above. */
export function loadEntityDetail(
  jwt: string,
  projectId: string,
  path: string,
): Promise<AquiferEntityDetail> {
  const cached = detailCache.get(path)
  if (cached) return cached
  const promise = aquiferReadPage(jwt, projectId, path, { maxChars: ENTITY_MAX_CHARS })
    .then((page) => {
      const body = pageBody(page)
      return {
        url: page.url,
        summary: parseEntitySummary(body),
        coordinates: parseEntityCoordinates(body),
        image: parseEntityImage(body, page.url),
      }
    })
    .catch((err) => {
      detailCache.delete(path)
      throw err
    })
  detailCache.set(path, promise)
  return promise
}

// ── Prefetch (AQU-843) ──────────────────────────────────────────────────────

/** `/en/passages/RUT/1/8/` → its book, chapter and verse. */
const PASSAGE_PATH = /^(\/[a-z]{2}\/passages\/[A-Z0-9]{2,4}\/\d+\/)(\d+)\/$/

/**
 * Sibling verse paths worth warming around the verse in view (AQU-843).
 * Forward first — reading order. Verse 1 has no predecessor.
 *
 * The chapter's last verse is NOT knowable here: a passage page doesn't carry
 * the verse count. Walking off the end is therefore left to
 * `prefetchPassageEntities`, which remembers the miss instead of re-asking.
 */
export function adjacentPassagePaths(passagePath: string): string[] {
  const m = PASSAGE_PATH.exec(passagePath)
  if (!m) return []
  const [, prefix, verseStr] = m
  const verse = Number(verseStr)
  const targets = [`${prefix}${verse + 1}/`]
  if (verse - 1 >= 1) targets.push(`${prefix}${verse - 1}/`)
  return targets
}

/** Paths a preload has already asked for and been refused — the end of a
 *  chapter, mostly. Never retried: a translator parked on the last verse must
 *  not re-spend a request on the verse after it every time the effect runs. */
const warmMisses = new Set<string>()

/**
 * Warm one verse's entity list so scrolling onto it renders from memory rather
 * than blocking on a cold fetch (AQU-843).
 *
 * Entity *details* are deliberately not warmed — they fan out up to
 * MAX_DETAIL_LOOKUPS per verse, which is too much speculative traffic for the
 * weak links this exists for.
 *
 * Fire-and-forget: already-cached paths and known misses cost nothing.
 */
export function prefetchPassageEntities(
  jwt: string,
  projectId: string,
  passagePath: string,
): void {
  if (passageCache.has(passagePath) || warmMisses.has(passagePath)) return
  loadPassageEntities(jwt, projectId, passagePath).catch(() => {
    warmMisses.add(passagePath)
  })
}

/** Test seam — drops both promise caches and the warm-miss memo. */
export function __resetPassageResourceCaches(): void {
  passageCache.clear()
  detailCache.clear()
  warmMisses.clear()
}

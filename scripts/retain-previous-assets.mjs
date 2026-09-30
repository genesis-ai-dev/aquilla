// AQU-1405: keep the previous build's hashed chunks alive across a deploy.
//
// Workers static assets are replaced wholesale: the moment a new build is
// promoted, every `assets/app-chunk-<old-hash>.js` returns the SPA fallback
// instead of JavaScript, and any tab still running the old `index.html` breaks
// the next time it lazy-loads a route. The client recovers by reloading once
// (src/lib/chunk-reload.ts), but a reload is a lost scroll position and a
// visible stutter — on a Thailand/Myanmar link, several seconds of it.
//
// So the deploy carries the recently superseded chunks forward. Each SPA deploy
// publishes `asset-manifest.json` listing everything under `dist/assets`; the
// next deploy reads the live manifest, re-downloads the chunks its own build no
// longer contains, and drops them into `dist/` before upload. An entry is kept
// until RETENTION_MS after the deploy that superseded it, so a chunk the old
// tab still points at answers 200 for a full day rather than disappearing the
// instant a deploy lands.
//
// This must never be the reason a deploy fails: an unreachable or malformed
// live manifest degrades to "publish only this build's assets" with a warning.
//
// Usage: node scripts/retain-previous-assets.mjs <dist-dir> <base-url>

import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

/** Published path of the manifest, relative to the asset root. */
export const ASSET_MANIFEST_PATH = "asset-manifest.json"

/** Minimum lifetime of a superseded chunk, counted from the deploy that replaced it. */
export const RETENTION_MS = 24 * 60 * 60 * 1000

/** Only hashed build output is carried forward — index.html and friends are always current. */
export const RETAINED_PREFIX = "assets/"

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

/** The manifest arrives over the network: only plain paths under assets/ are honoured. */
function isSafeAssetPath(value) {
  const segments = value.split("/")
  if (segments.length < 2 || segments[0] !== "assets") return false
  return segments.slice(1).every((segment) => SAFE_SEGMENT.test(segment) && segment !== "." && segment !== "..")
}

/** Every file under `<distDir>/assets`, as published paths ("assets/app-chunk-x.js"). */
export function currentAssetPaths(distDir) {
  const root = path.resolve(distDir, "assets")
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true, recursive: true })
  } catch {
    return [] // no assets/ dir — nothing hashed to retain against
  }
  return entries
    .filter((entry) => entry.isFile())
    // `parentPath` on Node ≥ 20.12; `path` is its deprecated alias on older ones.
    .map((entry) => path.relative(path.resolve(distDir), path.resolve(entry.parentPath ?? entry.path ?? root, entry.name)))
    .map((relative) => relative.split(path.sep).join("/"))
    .sort()
}

/** Parse a live manifest defensively: anything unexpected reads as "no previous manifest". */
export function parseAssetManifest(raw) {
  let parsed
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw
  } catch {
    return { assets: [] }
  }
  const assets = Array.isArray(parsed?.assets) ? parsed.assets : []
  return {
    assets: assets
      .filter((entry) => typeof entry?.path === "string" && isSafeAssetPath(entry.path))
      .map((entry) => ({
        path: entry.path,
        retainUntil: typeof entry.retainUntil === "string" ? entry.retainUntil : null,
      })),
  }
}

/**
 * Decide what the new manifest holds and which files have to be fetched back.
 *
 * - a path this build produced is live, and carries no expiry;
 * - a path only the previous manifest had is retained until `retainUntil`,
 *   stamped at now + retentionMs the first time it is superseded (so the clock
 *   starts at the deploy that removed it, not at the build that created it);
 * - a retained path whose expiry has passed is dropped.
 */
export function reconcileAssetManifest({ currentPaths, previous, now, retentionMs = RETENTION_MS }) {
  const current = new Set(currentPaths.filter((entry) => entry.startsWith(RETAINED_PREFIX)))
  const nowMs = now.getTime()
  const restore = []

  for (const entry of parseAssetManifest(previous).assets) {
    if (current.has(entry.path)) continue
    const retainUntil = entry.retainUntil ?? new Date(nowMs + retentionMs).toISOString()
    const expiresAt = Date.parse(retainUntil)
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) continue
    restore.push({ path: entry.path, retainUntil })
  }

  const assets = [
    ...[...current].map((assetPath) => ({ path: assetPath, retainUntil: null })),
    ...restore,
  ].sort((a, b) => a.path.localeCompare(b.path))

  return {
    manifest: { schemaVersion: 1, generatedAt: now.toISOString(), assets },
    restore: restore.sort((a, b) => a.path.localeCompare(b.path)),
  }
}

async function fetchText(fetchImpl, url) {
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return await res.text()
}

/**
 * Fetch the live manifest, restore the chunks it still owes, and write the new
 * manifest into `distDir`. Resolves to a summary; never throws for a network or
 * manifest problem (the deploy proceeds with this build's assets alone).
 */
export async function retainPreviousAssets({
  distDir,
  baseUrl,
  now = new Date(),
  retentionMs = RETENTION_MS,
  fetchImpl = fetch,
  log = console,
}) {
  const dist = path.resolve(distDir)
  const origin = baseUrl.replace(/\/+$/, "")

  let previous = { assets: [] }
  try {
    previous = parseAssetManifest(await fetchText(fetchImpl, `${origin}/${ASSET_MANIFEST_PATH}`))
  } catch (error) {
    log.warn?.(
      `[retain-previous-assets] no usable live manifest at ${origin}/${ASSET_MANIFEST_PATH} ` +
        `(${error instanceof Error ? error.message : String(error)}) — publishing this build's assets only`,
    )
  }

  const { manifest, restore } = reconcileAssetManifest({
    currentPaths: currentAssetPaths(dist),
    previous,
    now,
    retentionMs,
  })

  const restored = []
  const unavailable = []
  for (const entry of restore) {
    const target = path.resolve(dist, entry.path)
    // Defence in depth: the manifest is fetched over the network, so never let
    // one of its paths escape dist/ even though the shape check already ran.
    if (!target.startsWith(`${dist}${path.sep}`)) continue
    try {
      const res = await fetchImpl(`${origin}/${entry.path}`)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, Buffer.from(await res.arrayBuffer()))
      restored.push(entry.path)
    } catch (error) {
      unavailable.push(entry.path)
      log.warn?.(
        `[retain-previous-assets] could not carry forward ${entry.path} ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }

  // A chunk that could not be re-downloaded is not retained, so it must not be
  // advertised — otherwise the next deploy keeps chasing a file nobody has.
  const missing = new Set(unavailable)
  manifest.assets = manifest.assets.filter((entry) => !missing.has(entry.path))

  mkdirSync(dist, { recursive: true })
  writeFileSync(path.resolve(dist, ASSET_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`)
  log.log?.(
    `[retain-previous-assets] ${manifest.assets.length} assets published ` +
      `(${restored.length} carried forward from the previous build, ${unavailable.length} unavailable)`,
  )
  return { manifest, restored, unavailable }
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  const [distDir = "dist", baseUrl] = process.argv.slice(2)
  if (!baseUrl) {
    console.error("usage: node scripts/retain-previous-assets.mjs <dist-dir> <base-url>")
    process.exit(2)
  }
  try {
    await retainPreviousAssets({ distDir, baseUrl })
  } catch (error) {
    // Only a local filesystem failure reaches here; still not worth a red
    // deploy, but say so loudly enough to be seen in the build log.
    console.warn(
      `[retain-previous-assets] skipped: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Staleness signal for captured localization screenshots (AQU-832 relaxation).
 *
 * `context.test.ts` used to only assert a declared surface's PNG file
 * *exists* (`existsSync`). That's necessary but not sufficient: a surface
 * whose driver or route quietly stopped matching its `notes` still has a
 * file on disk, so nothing caught it. `project-settings` is exactly this —
 * its driver (`scripts/i18n-shots/common.ts`) stops at `/settings`, which now
 * renders an 8-card index, not the ~150 form strings its `notes` promise a
 * translator will see. See docs/I18N-CONTEXT-CATALOG.md "why this changed".
 *
 * The fix is a small manifest (`screenshots/manifest.json`) recording, per
 * surface, the sha256 of its PNG and the `route` it was captured against, at
 * the commit the capture was last verified current. A mismatch on either
 * axis — or a missing entry — means the capture and its metadata have
 * drifted apart without anyone re-running `pnpm i18n:shots`:
 *
 *   - PNG bytes changed (recaptured, or hand-edited) without a manifest
 *     update → `hash-mismatch`;
 *   - the surface's declared `route` changed without a recapture →
 *     `route-mismatch`;
 *   - the PNG was deleted → `missing-file`;
 *   - the surface was never captured, or is a known, deliberately unrecaptured
 *     gap (see `project-settings` above) → `missing-manifest-entry`.
 *
 * This only ever hashes committed files and reads a committed JSON manifest —
 * it never launches a browser or needs the dev stack, so it runs in the
 * normal `pnpm test` path.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { ScreenshotSurface } from "./namespaces/types"
import { screenshotPath } from "./screenshots"

export interface ScreenshotManifestEntry {
  /** sha256 of the PNG bytes, hex-encoded, as of `capturedAt`. */
  hash: string
  /** The surface's `route` at the time this entry was recorded. */
  route: string
  /** Short git commit (or ISO date) this entry was last verified current at. */
  capturedAt: string
}

export type ScreenshotManifest = Record<string, ScreenshotManifestEntry>

/** Repo-relative path of the manifest, alongside the PNGs it describes. */
export const SCREENSHOT_MANIFEST_PATH = "src/lib/i18n/screenshots/manifest.json"

export function loadScreenshotManifest(repoRoot: string): ScreenshotManifest {
  const file = path.join(repoRoot, SCREENSHOT_MANIFEST_PATH)
  if (!existsSync(file)) return {}
  return JSON.parse(readFileSync(file, "utf8")) as ScreenshotManifest
}

/** sha256 of a repo-relative file's bytes, or `undefined` if it doesn't exist. */
export function hashFile(repoRoot: string, repoRelativePath: string): string | undefined {
  const file = path.join(repoRoot, repoRelativePath)
  if (!existsSync(file)) return undefined
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

export type StalenessReason =
  | "missing-file"
  | "missing-manifest-entry"
  | "hash-mismatch"
  | "route-mismatch"

/**
 * Why `surface`'s capture is stale relative to `manifest`, or `undefined` when
 * it's current. Checked in the order a human would debug it: does the file
 * exist, is it attested at all, do the bytes match, does the route match.
 */
export function screenshotStaleness(
  repoRoot: string,
  surface: ScreenshotSurface,
  manifest: ScreenshotManifest,
): StalenessReason | undefined {
  const actualHash = hashFile(repoRoot, screenshotPath(surface.id))
  if (actualHash === undefined) return "missing-file"
  const entry = manifest[surface.id]
  if (!entry) return "missing-manifest-entry"
  if (entry.hash !== actualHash) return "hash-mismatch"
  if (entry.route !== surface.route) return "route-mismatch"
  return undefined
}

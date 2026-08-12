/**
 * Localization screenshot surfaces (AQU-832).
 *
 * A "surface" is one screen or dialog of the app that a translator can look at
 * to understand a whole group of strings at once — the workspace nav, the cell
 * editor, a confirm dialog, settings. One screenshot therefore covers dozens of
 * keys, which is what makes context metadata cheap enough to keep complete.
 *
 * This registry is the single source of truth for the screenshot set:
 *   - `context.ts` may only reference a surface declared here (enforced by
 *     `catalogContextIssues()`), so metadata can never point at a shot that
 *     nothing produces;
 *   - `scripts/i18n-shots.ts` drives each declared surface and writes its PNG,
 *     and a test asserts every surface has a driver, so adding a surface here
 *     plus a driver there is the only step needed to get it captured.
 *
 * Like `messages/en.ts` and `context.ts`, this file is a barrel: each surface is
 * declared by the namespace module whose strings appear in it, under
 * `namespaces/`.
 *
 * Files land at `<SCREENSHOT_DIR>/<id>.png` and are referenced by the stable
 * `id`, never by path, so the storage location can move (repo → R2) without
 * rewriting the metadata.
 */

import { NAMESPACES } from "./namespaces"
import type { ScreenshotSurface } from "./namespaces/types"

/** Repo-relative directory holding the captured surface screenshots. */
export const SCREENSHOT_DIR = "src/lib/i18n/screenshots"

export type { ScreenshotSurface } from "./namespaces/types"

/**
 * Every surface any namespace declares, in namespace order.
 *
 * `ScreenshotId` is `string` rather than a literal union: `flatMap` over the
 * namespace list cannot produce one, and deriving the union here is what would
 * force namespace modules to import from this barrel. The invariants that union
 * used to buy are enforced at test time instead — `catalogContextIssues()`
 * rejects an undeclared id, and `context.test.ts` asserts every declared surface
 * has a capture driver in `scripts/i18n-shots/`.
 */
export const SCREENSHOTS: readonly ScreenshotSurface[] = NAMESPACES.flatMap((ns) => ns.surfaces)

export type ScreenshotId = string

const SCREENSHOT_IDS: ReadonlySet<string> = new Set(SCREENSHOTS.map((s) => s.id))

export function isScreenshotId(id: string): boolean {
  return SCREENSHOT_IDS.has(id)
}

/** Repo-relative path of a surface's PNG. */
export function screenshotPath(id: string): string {
  return `${SCREENSHOT_DIR}/${id}.png`
}

export function screenshotSurface(id: string): ScreenshotSurface | undefined {
  return SCREENSHOTS.find((s) => s.id === id)
}

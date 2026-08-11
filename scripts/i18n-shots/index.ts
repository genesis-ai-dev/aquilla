/**
 * Registry of localization capture drivers, one module per namespace (AQU-511).
 *
 * `SCREENSHOTS` widened to `readonly ScreenshotSurface[]` when the catalog split
 * into namespace modules, so `Record<ScreenshotId, SurfaceDriver>` no longer
 * enforces driver coverage at compile time. `SURFACE_DRIVER_IDS` restores the
 * invariant as a runtime one: `src/lib/i18n/context.test.ts` asserts it matches
 * the declared surface set in both directions, so a surface with no driver — or
 * a driver for a surface nobody declares — fails CI rather than failing at
 * capture time.
 *
 * Import this module by its explicit `/index` path. `scripts/i18n-shots` alone
 * resolves to the capture CLI, which runs on import.
 */

import { common } from "./common"
import { nav } from "./nav"
import { error } from "./error"
import { dialog } from "./dialog"
import { editor } from "./editor"
import { comments } from "./comments"
import { auth } from "./auth"
import { search } from "./search"
import { audio } from "./audio"
import type { SurfaceDriver } from "./shared"

export type { SurfaceDriver } from "./shared"

export const DRIVERS: Record<string, SurfaceDriver> = {
  ...common,
  ...nav,
  ...error,
  ...dialog,
  ...editor,
  ...comments,
  ...auth,
  ...search,
  ...audio,
}

export const SURFACE_DRIVER_IDS: readonly string[] = Object.keys(DRIVERS)

/**
 * Shared constants and the driver signature for the per-namespace capture
 * drivers (AQU-511).
 *
 * Lives apart from `index.ts` so a namespace's driver module imports only this
 * leaf, never the aggregating barrel.
 */

import type { Page } from "@playwright/test"

/** One driver: put the page in the state its surface describes, then return. */
export type SurfaceDriver = (page: Page) => Promise<void>

/** A namespace's drivers, keyed by the surface id its module declares. */
export type SurfaceDrivers = Record<string, SurfaceDriver>

/** App origin; override when Vite is not on :5173. */
export const BASE_URL = process.env.I18N_SHOTS_BASE_URL || "http://127.0.0.1:5173"

/** The dev-bypass seed project + org (auth-worker `/__dev__/seed`). */
export const DEV_PROJECT = "dev-project"
export const DEV_ORG_ID = 1

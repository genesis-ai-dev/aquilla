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

/** auth-worker origin (`pnpm dev` puts identity on :8788). */
export const IDENTITY_BASE = process.env.I18N_SHOTS_IDENTITY_BASE || "http://127.0.0.1:8788"

/** sync-worker origin (`pnpm dev` puts sync on :8789). */
export const SYNC_BASE = process.env.I18N_SHOTS_SYNC_BASE || "http://127.0.0.1:8789"

/** The dev-bypass seed project (auth-worker `/__dev__/seed`). */
export const DEV_PROJECT = "dev-project"

/**
 * The seeded org's numeric id.
 *
 * `organizations.id` is a serial, so "Dev Org" is only id 1 in a database whose
 * very first org was the dev seed — on a Postgres that has seen any other org
 * (which the shared local dev container has) it is something else, and the old
 * hard-coded `1` sent the workspace-nav driver to a different org's page. The
 * capture run reads the real id out of `/__dev__/login` and publishes it here
 * before driving any surface.
 */
let devOrgId: number | null = null

export function setDevOrgId(id: number): void {
  devOrgId = id
}

export function requireDevOrgId(): number {
  if (devOrgId === null) {
    throw new Error("dev org id not resolved yet — call setDevOrgId() before driving surfaces")
  }
  return devOrgId
}

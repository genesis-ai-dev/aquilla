// Typed fetch wrappers for frontier-server project settings read/write API
// (Phase 2b). Aliases over the existing `project-settings.ts` so the new
// `useProjectSettings` hook can sit on top of one consistent naming scheme
// without disturbing existing callers of the underlying primitives.

import {
  fetchProjectSettings as legacyFetchProjectSettings,
  patchProjectSettings,
  type ProjectSettingsResponse,
  type ProjectWideSettings,
} from "./project-settings"
import type { WriteSettingsOutcome } from "./settings-read-types"

export type {
  ProjectWideSettings,
  ProjectSettingsResponse,
} from "./project-settings"
export type { WriteSettingsOutcome } from "./settings-read-types"

export class SettingsReadError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(`settings-read failed: HTTP ${status} — ${message}`)
    this.status = status
    this.name = "SettingsReadError"
  }
}

/**
 * GET /api/v2/projects/:projectId/settings.
 *
 * Returns null on 403 (no access), 404 (no project), and any network error
 * — matching the legacy wrapper's UX-friendly signature. Hook callers
 * distinguish null from `{version: 0, settings: {}}` (no row yet) when they
 * need to know "fetch attempted vs no fetch yet."
 */
export async function fetchProjectSettings(
  projectId: string,
  jwt: string,
): Promise<ProjectSettingsResponse | null> {
  return await legacyFetchProjectSettings(jwt, projectId)
}

/**
 * PUT-ish write (`PATCH` server-side) of project settings with optimistic
 * concurrency control via `ifMatchVersion`. Returns:
 *   - `{ kind: "ok", value }` on 200 (settings applied; new `version` carried back)
 *   - `{ kind: "conflict", latest }` on 409 (caller's `ifMatchVersion` mismatched
 *     — the server returns the current row so callers can rebase + retry)
 *   - `{ kind: "error", status, message }` on every other failure including
 *     403/role gating
 */
export async function writeProjectSettings(
  projectId: string,
  settings: ProjectWideSettings,
  ifMatchVersion: number,
  jwt: string,
): Promise<WriteSettingsOutcome> {
  const result = await patchProjectSettings(jwt, projectId, settings, ifMatchVersion)
  if (result.kind === "ok") return { kind: "ok", value: result.value }
  if (result.kind === "conflict") return { kind: "conflict", latest: result.latest }
  if (result.kind === "forbidden") {
    return {
      kind: "error",
      status: 403,
      message: `forbidden (need role ${result.required}; have ${result.role})`,
    }
  }
  return { kind: "error", status: result.status, message: result.message }
}

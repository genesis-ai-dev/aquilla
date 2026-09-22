// Shared "read ONE project" query for the Agent API (AQU-1222).
//
// Used by both the MCP `get_project` tool (mcp-handlers.ts) and the REST
// `GET /api/v1/external/projects/:projectId` route (read-routes.ts) so the two
// adapters can never drift — the same contract projects-list.ts holds for the
// list read.
//
// It carries the project's settings blob AND its settings `version`, because
// `PatchSettings.ifMatchVersion` must equal the LIVE version or prepare returns
// plan_stale. Before this module no agent-reachable read returned that number,
// so a caller could only guess it (AQU-1176 built the write half; AQU-1222 is
// its missing read half).
//
// Callers own auth: resolve credential scope + the caller's live project role
// FIRST, then pass that role in. This module does no permission work — it is a
// query, not a gate.

import { loadProjectSettings } from '../../../db/shared/projects'

export interface ExternalProjectDetail {
  id: string
  name: string
  /** Stringified so a bigint org id survives JSON — matches projects-list.ts. */
  org_id: string | null
  archived: boolean
  /** The caller's live role level on this project, resolved by the caller. */
  role: number
  /** Normalized project settings blob (empty object when never written). */
  settings: Record<string, unknown>
  /** Live project_settings.version — pass this as PatchSettings.ifMatchVersion.
   *  0 when the project has no settings row yet (the first write creates it). */
  settingsVersion: number
  settingsUpdatedAt: string | null
}

interface ProjectDetailRow {
  id: string
  name: string
  org_id: number | string | bigint | null
  archived_at: string | null
}

/** Read one project plus its live settings/version. Returns null when no such
 *  project exists — the caller maps that to not_found. */
export async function loadProjectDetail(
  db: AquillaDb,
  projectId: string,
  role: number,
): Promise<ExternalProjectDetail | null> {
  const row = await db
    .prepare('SELECT id, name, org_id, archived_at FROM projects WHERE id = ?')
    .bind(projectId)
    .first<ProjectDetailRow>()
  if (!row) return null

  const settings = await loadProjectSettings(db, projectId)
  return {
    id: row.id,
    name: row.name,
    org_id: row.org_id == null ? null : String(row.org_id),
    archived: row.archived_at != null,
    role,
    settings: settings.settings,
    settingsVersion: settings.version,
    settingsUpdatedAt: settings.updatedAt,
  }
}

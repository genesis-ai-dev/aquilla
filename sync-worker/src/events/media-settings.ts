// AQU-1768: the project's settings with the org's media defaults filled in.
//
// The timing lock, track editing and the audio validation gates read their
// keys from this instead of the project's own settings, so a project that
// sets nothing of its own follows its org's default (project → org → each
// reader's built-in default). The project side is the write path's narrow
// projection (AQU-1840), which carries every media key the sync worker
// enforces; `cellEditingFloor` is not one of them (only the agent path in
// auth-worker gates on it). All three reads go through the request memo, so a
// batch still pays one project_settings, one projects and one org_settings
// read at most.
//
// A database failure REJECTS, like the memo it reads through: every caller
// already wraps its settings read in its own fail-safe.

import { withOrgMediaDefaults } from '../../../db/shared/media-setting-defaults'
import type { RequestCache } from './request-cache'
import type { WritePathSettings } from './write-path-settings'

export async function effectiveMediaSettings(
  cache: RequestCache,
  projectId: string,
): Promise<WritePathSettings | null> {
  const [project, orgId] = await Promise.all([
    cache.writePathSettings(projectId),
    cache.projectOrgId(projectId),
  ])
  const org = orgId == null ? null : await cache.orgSettings(orgId)
  return withOrgMediaDefaults(project ? { ...project } : null, org) as WritePathSettings | null
}

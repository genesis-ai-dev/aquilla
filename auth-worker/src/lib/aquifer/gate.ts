// The Bible Aquifer feature gate: project_settings.bibleResourcesEnabled.
//
// Single source of truth so the agent (execute.aquifer branch) and the
// read-only aquifer routes agree on whether the feature is on for a project.
// Default OFF — absent row, absent key, or any non-true value all read false.

import type { Env } from "../../types"

/** True only when the project explicitly enabled Bible resources. */
export async function isBibleResourcesEnabled(env: Env, projectId: string): Promise<boolean> {
  try {
    const row = await env.AQUILLA_PG.prepare(
      `SELECT settings::jsonb ->> 'bibleResourcesEnabled' AS enabled
         FROM project_settings WHERE project_id = ?`,
    )
      .bind(projectId)
      .first<{ enabled: string | null }>()
    return row?.enabled === "true"
  } catch {
    // Fail closed — if we can't read the flag, the feature stays off.
    return false
  }
}

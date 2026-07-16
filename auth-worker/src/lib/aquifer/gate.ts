// The Bible Aquifer feature gate: project_settings.bibleResourcesEnabled.
//
// Single source of truth so the agent (execute.aquifer branch) and the
// read-only aquifer routes agree on whether the feature is on for a project.
//
// AQU-460 derive-on-read: `bibleResourcesEnabled` in project_settings is the
// EXPLICIT user override only — nothing writes it on load. The effective
// value is DERIVED at read time:
//   explicit === "true"  -> allow
//   explicit === "false" -> deny (always respected, even for scripture projects
//                            — this is the trust invariant the redesign exists
//                            for; a prior load-time auto-enable effect silently
//                            overrode an explicit OFF)
//   explicit unset/null  -> allow IFF the project has scripture files
//
// Mirrors the client's `resolveBibleResourcesEnabled` in
// src/lib/parsers/types.ts (auth-worker is a separate compile unit — no
// cross-import — so the file-type set is duplicated here deliberately).

import type { Env } from "../../types"

/** Server projection of the client's SCRIPTURE_FILE_TYPES (src/lib/parsers/types.ts).
 *  `files.kind` is populated from the client's FileType on file.create.
 *  Fixed literal set (not user input) — inlined as an `IN (...)` list to
 *  match the codebase's existing placeholder convention. */
const SCRIPTURE_FILE_KINDS = ["usfm", "ebible", "helloao"] as const

/** True when the project has at least one non-deleted scripture-type file. */
async function projectHasScriptureFiles(env: Env, projectId: string): Promise<boolean> {
  try {
    const placeholders = SCRIPTURE_FILE_KINDS.map(() => "?").join(",")
    const row = await env.AQUILLA_PG.prepare(
      `SELECT EXISTS (
         SELECT 1 FROM files
          WHERE project_id = ?
            AND deleted_at IS NULL
            AND kind IN (${placeholders})
       ) AS has_scripture`,
    )
      .bind(projectId, ...SCRIPTURE_FILE_KINDS)
      .first<{ has_scripture: boolean }>()
    return row?.has_scripture === true
  } catch {
    // Fail closed — if we can't tell, don't broaden access.
    return false
  }
}

/**
 * Effective Bible-resources availability for a project: explicit override
 * when set, otherwise derived from scripture-file presence. Never writes.
 */
export async function isBibleResourcesEnabled(env: Env, projectId: string): Promise<boolean> {
  let explicit: boolean | undefined
  try {
    const row = await env.AQUILLA_PG.prepare(
      `SELECT settings::jsonb ->> 'bibleResourcesEnabled' AS enabled
         FROM project_settings WHERE project_id = ?`,
    )
      .bind(projectId)
      .first<{ enabled: string | null }>()
    if (row?.enabled === "true") explicit = true
    else if (row?.enabled === "false") explicit = false
    // else: no row / no key / unexpected value -> unset, fall through to derive.
  } catch {
    // Fail closed on the settings read too — but still allow derivation from
    // scripture files below rather than hard-denying (settings unreadable is
    // not itself a security-relevant "explicit false").
  }

  if (explicit !== undefined) return explicit
  return projectHasScriptureFiles(env, projectId)
}

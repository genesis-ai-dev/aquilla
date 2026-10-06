// The Bible Aquifer feature gate: project_settings.bibleResourcesEnabled.
//
// Single source of truth so the agent (execute.aquifer branch) and the
// read-only aquifer routes agree on whether the feature is on for a project.
//
// AQU-460 derive-on-read: `bibleResourcesEnabled` in project_settings is the
// EXPLICIT user override only — nothing writes it on load. The effective
// value is DERIVED at read time:
//   explicit === true    -> allow
//   explicit === false   -> deny (always respected, even for scripture projects
//                            — this is the trust invariant the redesign exists
//                            for; a prior load-time auto-enable effect silently
//                            overrode an explicit OFF)
//   explicit unset/null  -> allow IFF the project has scripture files
//
// Mirrors the client's `resolveBibleResourcesEnabled` in
// src/lib/parsers/types.ts (auth-worker is a separate compile unit — no
// cross-import — so the file-type set is duplicated here deliberately).
//
// AQU-1686: the explicit switches are read from project_settings' generated
// columns (migration 0150), never from the settings blob, which runs to
// several MB. `readBibleEnrichmentFlags` resolves the per-enrichment Bible
// data switches with the same rules the SPA uses
// (db/shared/bible-enrichments.ts), for server-side readers such as autopilot.

import type { Env } from "../../types"
import {
  readBibleEnrichments,
  resolveBibleEnrichments,
  type BibleEnrichmentId,
} from "../../../../db/shared/bible-enrichments"

/** Server projection of the client's SCRIPTURE_FILE_TYPES (src/lib/parsers/types.ts).
 *  `files.kind` is populated from the client's FileType on file.create.
 *  Fixed literal set (not user input) — inlined as an `IN (...)` list to
 *  match the codebase's existing placeholder convention.
 *
 *  AQU-997: keep this list in step with SCRIPTURE_FILE_TYPES — `codex` (the
 *  native Scripture notebook kind every migrated Codex book carries) was
 *  missing from both, so a pure-codex project read as having no Scripture
 *  files and was under-recognized for project-level Bible resources. */
const SCRIPTURE_FILE_KINDS = ["usfm", "ebible", "helloao", "codex"] as const

/** True when the project has at least one non-deleted native Scripture file or
 * a format-neutral import whose manifest contains canonical Scripture units. */
async function projectHasScriptureFiles(env: Env, projectId: string): Promise<boolean> {
  try {
    const placeholders = SCRIPTURE_FILE_KINDS.map(() => "?").join(",")
    const row = await env.AQUILLA_PG.prepare(
      `SELECT EXISTS (
         SELECT 1 FROM files
          WHERE project_id = ?
            AND deleted_at IS NULL
            AND (
              kind IN (${placeholders})
              OR meta::jsonb -> 'aquillaImport' ->> 'hasScriptureContent' = 'true'
            )
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

interface ExplicitBibleData {
  /** The explicit Bible data switch; undefined when the project never chose. */
  switchValue: boolean | undefined
  /** The stored `bibleEnrichments` value, unvalidated. */
  enrichments: unknown
}

/** The explicit switches, from the generated columns only. */
async function readExplicitBibleData(env: Env, projectId: string): Promise<ExplicitBibleData> {
  try {
    const row = await env.AQUILLA_PG.prepare(
      `SELECT bible_resources_enabled, bible_enrichments
         FROM project_settings WHERE project_id = ?`,
    )
      .bind(projectId)
      .first<{ bible_resources_enabled: boolean | null; bible_enrichments: unknown }>()
    // No row, or NULL (no key, or a value that is not a JSON boolean): unset.
    const value = row?.bible_resources_enabled
    return {
      switchValue: typeof value === "boolean" ? value : undefined,
      enrichments: row?.bible_enrichments ?? null,
    }
  } catch {
    // Settings unreadable is not itself a security-relevant "explicit false",
    // so derive from scripture files rather than hard-denying.
    return { switchValue: undefined, enrichments: null }
  }
}

/**
 * Effective Bible-resources availability for a project: explicit override
 * when set, otherwise derived from scripture-file presence. Never writes.
 */
export async function isBibleResourcesEnabled(env: Env, projectId: string): Promise<boolean> {
  const { switchValue } = await readExplicitBibleData(env, projectId)
  if (switchValue !== undefined) return switchValue
  return projectHasScriptureFiles(env, projectId)
}

/**
 * AQU-1686: the effective value of every Bible data enrichment for a project.
 * The Bible data switch off means every flag is false; otherwise an explicit
 * choice wins, then the registry default. Reads the files table only when the
 * switch is unset, and fails closed there like `isBibleResourcesEnabled`.
 */
export async function readBibleEnrichmentFlags(
  env: Env,
  projectId: string,
): Promise<Record<BibleEnrichmentId, boolean>> {
  const { switchValue, enrichments } = await readExplicitBibleData(env, projectId)
  const hasScriptureFiles =
    switchValue === undefined ? await projectHasScriptureFiles(env, projectId) : false
  return resolveBibleEnrichments(
    { bibleResourcesEnabled: switchValue, bibleEnrichments: readBibleEnrichments(enrichments) },
    hasScriptureFiles,
  )
}

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
// columns (migration 0150), not from the settings blob, which runs to several
// MB. `readBibleEnrichmentFlags` resolves the per-enrichment Bible data
// switches with the same rules the SPA uses (db/shared/bible-enrichments.ts),
// for server-side readers such as autopilot.
//
// A DATABASE WITHOUT 0150 STILL RESPECTS AN EXPLICIT OFF. If the column read
// fails, the switches are read from the blob exactly as the gate read them
// before AQU-1686. Treating that failure as "no choice" re-enabled Bible data
// on every scripture project that had switched it off, the trust bug the
// derive-on-read design above exists to prevent (the QA bot reproduced it on
// this PR's preview, where 0150 was not applied).

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

/** The explicit switches, from the generated columns; from the settings blob
 *  if that read fails (see the header). */
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
    // Most likely the columns do not exist yet (0150 not applied). Any other
    // failure lands in the same place: the blob read below either answers, or
    // fails too and behaves exactly as the gate did before AQU-1686.
    return readExplicitBibleDataFromBlob(env, projectId)
  }
}

/** The pre-0150 read: the switches straight out of the settings blob, mapped
 *  the way the generated column maps them (the `->>` strings "true" and
 *  "false"; anything else is unset). It parses the blob, so it runs only
 *  after the column read has failed. */
async function readExplicitBibleDataFromBlob(env: Env, projectId: string): Promise<ExplicitBibleData> {
  try {
    const row = await env.AQUILLA_PG.prepare(
      `SELECT settings::jsonb ->> 'bibleResourcesEnabled' AS enabled,
              settings::jsonb -> 'bibleEnrichments' AS enrichments
         FROM project_settings WHERE project_id = ?`,
    )
      .bind(projectId)
      .first<{ enabled: string | null; enrichments: unknown }>()
    return {
      switchValue: row?.enabled === "true" ? true : row?.enabled === "false" ? false : undefined,
      enrichments: row?.enrichments ?? null,
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

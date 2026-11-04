// AQU-2342: the worker-side read of THE project instructions.
//
// `resolveTranslationInstructions` (./translation-instructions.ts) is pure; this
// is the one place a worker turns a project id into its resolved text. The
// legacy `project_briefs` row is read ONLY when the project has not stored
// `translationInstructions` yet — it is a migrate-on-read source, never a
// second block a prompt injects beside the instructions.
//
// Best-effort by design: drafting must never die on grounding, so a failed
// read degrades to "no instructions" rather than throwing.

import {
  composeDeduplicated,
  decisionMemoryText,
  resolveTranslationInstructions,
  storedTranslationInstructions,
} from './translation-instructions'

/** The slice of the D1-compatible executor this module needs. */
export interface InstructionsDb {
  prepare(query: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>
      all<T>(): Promise<{ results: T[] }>
    }
  }
}

export interface LoadedTranslationInstructions {
  /** The resolved text every drafting prompt injects ("" when none). */
  text: string
  /** True when the project saved `translationInstructions` itself; false when
   *  `text` is composed on read from the old sources. */
  stored: boolean
}

/** A settings column value (jsonb object, or its JSON text) as an object. */
export function settingsObject(raw: unknown): Record<string, unknown> {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** The agent's legacy free-text brief, or "" (no row, or a failed read). */
export async function readProjectBriefText(db: InstructionsDb, projectId: string): Promise<string> {
  try {
    const row = await db
      .prepare('SELECT content FROM project_briefs WHERE project_id = ?')
      .bind(projectId)
      .first<{ content: string | null }>()
    return row?.content ?? ''
  } catch {
    return ''
  }
}

/**
 * The approved agent `decisions/` memories (oldest first, the order they were
 * decided), as instruction texts. AQU-2342 phase 2: approving a decision now
 * appends it to `translationInstructions`; decisions approved before that are
 * a migrate-on-read source. "" entries are dropped; a failed read is [].
 */
export async function readApprovedDecisionTexts(db: InstructionsDb, projectId: string): Promise<string[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT content FROM agent_memories
          WHERE project_id = ? AND status = 'approved' AND path LIKE 'decisions/%'
          ORDER BY created_at ASC`,
      )
      .bind(projectId)
      .all<{ content: string | null }>()
    return results.map((r) => decisionMemoryText(r.content ?? '')).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Every server-held migrate-on-read source composed into one text: the legacy
 * project brief, then the approved `decisions/` memories. The settings GET
 * hands this to the browser as `legacyProjectBriefText`, so the editor
 * resolves the same text the workers do.
 */
export async function readLegacyServerInstructions(db: InstructionsDb, projectId: string): Promise<string> {
  const [brief, decisions] = await Promise.all([
    readProjectBriefText(db, projectId),
    readApprovedDecisionTexts(db, projectId),
  ])
  return composeDeduplicated([brief, ...decisions])
}

/**
 * Resolve a project's instructions. Pass `settings` when the caller already
 * read the blob, so the row is not fetched twice.
 */
export async function loadTranslationInstructions(
  db: InstructionsDb,
  projectId: string,
  settings?: Record<string, unknown> | null,
): Promise<LoadedTranslationInstructions> {
  let blob = settings ?? null
  if (!blob) {
    try {
      const row = await db
        .prepare('SELECT settings FROM project_settings WHERE project_id = ?')
        .bind(projectId)
        .first<{ settings: unknown }>()
      blob = settingsObject(row?.settings)
    } catch {
      blob = {}
    }
  }
  if (storedTranslationInstructions(blob) !== null) {
    return { text: resolveTranslationInstructions(blob), stored: true }
  }
  const projectBriefText = await readLegacyServerInstructions(db, projectId)
  return { text: resolveTranslationInstructions(blob, { projectBriefText }), stored: false }
}

// Record one decided fact in project settings, INSIDE the caller's
// transaction (AQU-1691). contextual-decision-lifecycle.ts calls it in the
// same transaction that resolves the decision, so an answer and its fact
// commit together or not at all.
//
// WHY NOT updateProjectSettingsShared (./projects.ts): it writes through
// db.batch(), which opens a transaction of its own. Inside db.transaction()
// that cannot work — a postgres.js transaction handle has no begin(), and the
// PGlite test harness would open a second transaction on the root connection.
// So this is a deliberately NARROW second writer. It changes only
// `projectFacts` or `languageProfile`: no generated column, lane row or
// validation projection reads them, so the shared writer's lane minting and
// threshold re-projection have nothing to do here. It keeps the shared
// writer's version bump and normalizeSettings.
//
// CONCURRENCY: SELECT … FOR UPDATE holds the row until the decision commits.
// A settings write that races it waits on the row lock, then finds the version
// moved and returns its usual conflict, which the SPA retries over the fresh
// blob (src/hooks/useProjectSettings.ts). The caller notifies the sync-worker
// after the commit, as the settings routes do.

import type { AquillaDb } from '../shim/postgres'
import { normalizeSettings } from './projects'
import {
  applyProfileFact,
  profileSlotOfFactKey,
  upsertProjectFact,
  type FactAnswerRejection,
  type FactScope,
  type ProjectFact,
} from './project-facts'

export interface RecordFactInput {
  projectId: string
  key: string
  /** The answer as given. Trimmed here. */
  value: string
  scope?: FactScope | null
  note?: string
  /** Username shown as the fact's author. */
  author: string
  /** User id stamped as the settings row's `updated_by`. */
  updatedBy: number
  sourceDecisionId?: string
}

export type RecordFactResult =
  | { status: 'ok'; kind: 'profile' | 'fact'; version: number }
  | { status: 'rejected'; reason: FactAnswerRejection }

interface LockedRow {
  settings: string | null
  version: number
}

function parseBlob(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The project's settings blob as an object, or {} when it has none. Not locked. */
export async function readSettingsBlob(db: AquillaDb, projectId: string): Promise<Record<string, unknown>> {
  const row = await db
    .prepare(`SELECT settings FROM project_settings WHERE project_id = ?`)
    .bind(projectId)
    .first<{ settings: string | null }>()
  return parseBlob(row?.settings ?? null)
}

async function lockSettingsRow(tx: AquillaDb, projectId: string, updatedBy: number): Promise<LockedRow> {
  const select = () =>
    tx
      .prepare(`SELECT settings, version FROM project_settings WHERE project_id = ? FOR UPDATE`)
      .bind(projectId)
      .first<LockedRow>()
  const held = await select()
  if (held) return held
  // A project without a settings row yet. Version 0 stays inside this
  // transaction: the UPDATE below moves it to 1 before anyone can see it.
  await tx
    .prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_by)
       VALUES (?, '{}', 0, ?) ON CONFLICT (project_id) DO NOTHING`,
    )
    .bind(projectId, updatedBy)
    .run()
  const created = await select()
  if (!created) throw new Error(`project_settings row for ${projectId} could not be created`)
  return created
}

/**
 * Write the fact, or the Language-profile slot its key names, in `tx`.
 * Returns `rejected` without writing anything when the answer cannot be
 * stored; throws only on a database failure, so the caller's transaction
 * rolls back.
 */
export async function recordFactInTransaction(tx: AquillaDb, input: RecordFactInput): Promise<RecordFactResult> {
  const value = input.value.trim()
  if (!value) return { status: 'rejected', reason: 'answer-empty' }
  const row = await lockSettingsRow(tx, input.projectId, input.updatedBy)
  const settings = parseBlob(row.settings)
  const next: Record<string, unknown> = { ...settings }
  let kind: 'profile' | 'fact'
  if (profileSlotOfFactKey(input.key)) {
    const applied = applyProfileFact(settings.languageProfile, input.key, value)
    if (!applied.ok) return { status: 'rejected', reason: applied.reason }
    next.languageProfile = applied.profile
    kind = 'profile'
  } else {
    const fact: ProjectFact = {
      id: crypto.randomUUID(),
      key: input.key,
      value,
      scope: input.scope ?? {},
      ...(input.note ? { note: input.note } : {}),
      author: input.author,
      at: new Date().toISOString(),
      ...(input.sourceDecisionId ? { sourceDecisionId: input.sourceDecisionId } : {}),
    }
    const upserted = upsertProjectFact(settings.projectFacts, fact)
    if (!upserted.ok) return { status: 'rejected', reason: upserted.reason }
    next.projectFacts = upserted.facts
    kind = 'fact'
  }
  const written = await tx
    .prepare(
      `UPDATE project_settings
          SET settings = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP, updated_by = ?
        WHERE project_id = ? AND version = ?
        RETURNING version`,
    )
    .bind(JSON.stringify(normalizeSettings(next)), input.updatedBy, input.projectId, row.version)
    .first<{ version: number }>()
  // The row is locked, so only a broken lock could get here. Throwing rolls the decision back too.
  if (!written) throw new Error(`project_settings for ${input.projectId} moved under a row lock`)
  return { status: 'ok', kind, version: written.version }
}

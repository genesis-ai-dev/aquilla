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
// `projectFacts`, `languageProfile` or `translationInstructions`: no generated column, lane row or
// validation projection reads them, so the shared writer's lane minting and
// threshold re-projection have nothing to do here. It keeps the shared
// writer's version bump and normalizeSettings.
//
// CONCURRENCY: SELECT … FOR UPDATE holds the row until the decision commits.
// A settings write that races it waits on the row lock, then finds the version
// moved and returns its usual conflict, which the SPA retries over the fresh
// blob (src/hooks/useProjectSettings.ts). The caller notifies the sync-worker
// after the commit, as the settings routes do.

// AQU-2342 phase 2: a fact answer is ALSO appended to the project
// instructions — the one text every drafting prompt reads — in the same
// UPDATE. The fact entry is still kept: it is the record Autopilot checks so it
// never asks the same question twice (decidedFactKeys), and its provenance.
// A Language-profile answer is not appended: that slot is structured data the
// Bible data checks read, and every drafting prompt's checks hint carries it.
// `appendTranslationInstructionsLine` is the same append for callers with no
// fact (an approved agent `decisions/` memory).

import type { AquillaDb } from '../shim/postgres'
import { normalizeSettings } from './projects'
import { readLegacyServerInstructions } from './load-translation-instructions'
import {
  appendInstructionLine,
  projectFactInstructionLine,
  resolveTranslationInstructions,
  storedTranslationInstructions,
  TRANSLATION_INSTRUCTIONS_KEY,
} from './translation-instructions'
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
  updatedBy: number | null
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

async function lockSettingsRow(tx: AquillaDb, projectId: string, updatedBy: number | null): Promise<LockedRow> {
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
    const appended = appendInstructionLine(
      await currentInstructions(tx, input.projectId, settings),
      projectFactInstructionLine(fact),
    )
    // A full Instructions box is the team's to edit; the card says so.
    if (!appended.ok) return { status: 'rejected', reason: 'too-many-facts' }
    next[TRANSLATION_INSTRUCTIONS_KEY] = appended.text
    kind = 'fact'
  }
  return { status: 'ok', kind, version: await writeLocked(tx, input.projectId, next, input.updatedBy, row.version) }
}

/**
 * The instructions an append builds on: the stored text, or — while the
 * project has none — the text every prompt resolves today (migrate-on-read),
 * so the first append materializes it rather than replacing it.
 */
async function currentInstructions(
  tx: AquillaDb,
  projectId: string,
  settings: Record<string, unknown>,
): Promise<string> {
  if (storedTranslationInstructions(settings) !== null) return resolveTranslationInstructions(settings)
  const projectBriefText = await readLegacyServerInstructions(tx, projectId)
  return resolveTranslationInstructions(settings, { projectBriefText })
}

async function writeLocked(
  tx: AquillaDb,
  projectId: string,
  next: Record<string, unknown>,
  updatedBy: number | null,
  version: number,
): Promise<number> {
  const written = await tx
    .prepare(
      `UPDATE project_settings
          SET settings = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP, updated_by = ?
        WHERE project_id = ? AND version = ?
        RETURNING version`,
    )
    .bind(JSON.stringify(normalizeSettings(next)), updatedBy, projectId, version)
    .first<{ version: number }>()
  // The row is locked, so only a broken lock could get here. Throwing rolls the decision back too.
  if (!written) throw new Error(`project_settings for ${projectId} moved under a row lock`)
  return written.version
}

export type AppendInstructionsResult =
  | { status: 'ok'; changed: boolean; version: number | null }
  | { status: 'rejected'; reason: 'instructions-full' }

/**
 * Append one line to the project instructions in `tx` (row locked, version
 * bumped). A line the text already holds is a no-op (`changed: false`, no
 * write). Refused, writing nothing, when the box would overflow.
 */
export async function appendTranslationInstructionsLine(
  tx: AquillaDb,
  input: { projectId: string; line: string; updatedBy: number | null },
): Promise<AppendInstructionsResult> {
  const row = await lockSettingsRow(tx, input.projectId, input.updatedBy)
  const settings = parseBlob(row.settings)
  const appended = appendInstructionLine(await currentInstructions(tx, input.projectId, settings), input.line)
  if (!appended.ok) return { status: 'rejected', reason: appended.reason }
  if (!appended.changed && storedTranslationInstructions(settings) !== null) {
    return { status: 'ok', changed: false, version: null }
  }
  const next = { ...settings, [TRANSLATION_INSTRUCTIONS_KEY]: appended.text }
  return { status: 'ok', changed: true, version: await writeLocked(tx, input.projectId, next, input.updatedBy, row.version) }
}

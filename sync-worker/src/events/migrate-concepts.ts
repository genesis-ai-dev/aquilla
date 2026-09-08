// One-shot migration of a project's termbase off the project_settings JSON
// blob and onto the event log. (AQU-1006 follow-up)
//
// Concepts used to live under a single `terminology` key in project_settings.
// That key could only ever express "here is the ENTIRE termbase", so every add
// rewrote the whole array from the writer's stale snapshot and concurrent adds
// silently destroyed each other (2026-09-04: five people added terms on a demo
// call, one survived). The cutover is CLEAN — nothing reads the blob any more —
// which means an unmigrated project shows an EMPTY termbase until this runs.
// That is why this is lazy and automatic rather than an operator chore.
//
// ── IDEMPOTENT AND RACE-SAFE WITHOUT A LOCK ────────────────────────────────
// The obvious design is an advisory lock around "check, then migrate". This
// codebase has no advisory-lock usage anywhere, and it does not need one here,
// because BOTH writes are keyed on ids DERIVED from the data being migrated:
//
//   - `concepts.concept_id` is the blob concept's OWN id (a uuid the client
//     minted when the term was first created), and the projection insert is
//     `ON CONFLICT(concept_id) DO NOTHING`.
//   - the events row id is a deterministic hash of (projectId, conceptId),
//     and the events insert is `ON CONFLICT (id) DO NOTHING`.
//
// So N concurrent readers racing this migration all compute the SAME rows;
// whoever lands first wins and the rest no-op. Nothing is duplicated and
// nothing is lost. Correctness comes from the keys, not from mutual exclusion
// — which also means it survives a crash halfway through and a later re-run.
//
// The blob key is cleared only AFTER the rows are in, and clearing is itself
// tolerant of having already happened.

import type { AquillaDb, AquillaStatement } from '../../../db/shim/postgres'
import { buildEventInsertStmt } from './event-insert'
import { allocateSeqRange } from './event-insert'

/** Mirrors `Concept` in src/lib/terminology/types.ts. */
interface BlobConcept {
  id?: string
  sourceTerm?: string
  renderings?: Array<{ rendering?: string; status?: string }>
  notes?: string
  status?: string
  createdAt?: string
  createdBy?: string
  caseSensitive?: boolean
}

/**
 * A stable uuid-shaped id derived from (projectId, conceptId).
 *
 * MUST be deterministic: it is the events-table primary key that makes a
 * re-run a no-op instead of a second copy of every migration event. A random
 * uuid here would make this migration duplicate the entire event log on every
 * concurrent call.
 *
 * FNV-1a over the two ids, expanded to 32 hex chars. Not cryptographic and
 * does not need to be — the input space is uuids within one project, and a
 * collision would merely drop one migration event, not corrupt a concept
 * (the concept row is keyed on its own id).
 */
export function migrationEventId(projectId: string, conceptId: string): string {
  const input = `term-migrate:${projectId}:${conceptId}`
  // Four independently-seeded FNV-1a passes → 128 bits.
  const words: string[] = []
  for (const seed of [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b]) {
    let h = seed >>> 0
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    words.push(h.toString(16).padStart(8, '0'))
  }
  const hex = words.join('')
  // Shape it like a uuid so it reads correctly in the events table.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Coerce a blob rendering list to the projection's shape, dropping junk. */
function normalizeRenderings(raw: BlobConcept['renderings']): Array<{ rendering: string; status: string }> {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((r) => {
    const rendering = typeof r?.rendering === 'string' ? r.rendering : null
    const status =
      r?.status === 'preferred' || r?.status === 'admitted' || r?.status === 'forbidden'
        ? r.status
        : 'preferred'
    return rendering ? [{ rendering, status }] : []
  })
}

function normalizeStatus(raw: unknown): 'active' | 'draft' | 'deprecated' {
  return raw === 'active' || raw === 'deprecated' ? raw : 'draft'
}

/**
 * Statements per batch. Two statements per concept (the event row and the
 * projection row), so 200 is 100 concepts — small enough to keep any single
 * transaction short, large enough that a 961-concept termbase is ten batches
 * rather than a thousand round trips.
 */
const MIGRATION_CHUNK = 200

/**
 * Decode a project's LEGACY blob termbase into the read route's wire shape.
 *
 * Read-only. Used by the concepts read route as a fallback while a project is
 * still unmigrated, so nobody ever sees an empty termbase — see the long note
 * at that call site for why a fallback exists at all and why it does not
 * reopen the concurrent-add bug (the blob is never WRITTEN any more).
 *
 * Shares `loadBlobConcepts` with the migration itself, so what a user sees
 * before migration and what lands after it cannot drift apart.
 */
export async function readBlobConcepts(
  db: AquillaDb,
  projectId: string,
): Promise<Array<{
  conceptId: string
  projectId: string
  sourceTerm: string
  renderings: Array<{ rendering: string; status: string }>
  notes: string | null
  status: 'active' | 'draft' | 'deprecated'
  caseSensitive: boolean
  createdBy: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}>> {
  const concepts = await loadBlobConcepts(db, projectId)
  const now = Date.now()
  return concepts.map((c) => {
    const parsedAt = c.createdAt ? Date.parse(c.createdAt) : NaN
    const created = Number.isFinite(parsedAt) ? parsedAt : now
    return {
      conceptId: c.id,
      projectId,
      sourceTerm: c.sourceTerm,
      renderings: normalizeRenderings(c.renderings),
      notes: c.notes ?? null,
      status: normalizeStatus(c.status),
      caseSensitive: Boolean(c.caseSensitive),
      createdBy: c.createdBy ?? null,
      createdAt: created,
      updatedAt: created,
      deletedAt: null,
    }
  })
}

/**
 * The project's blob concepts, validated. Empty when the key is absent, the
 * blob will not parse, or every entry is unusable.
 */
async function loadBlobConcepts(
  db: AquillaDb,
  projectId: string,
): Promise<Array<BlobConcept & { id: string; sourceTerm: string }>> {
  const row = await db
    .prepare('SELECT settings FROM project_settings WHERE project_id = ?')
    .bind(projectId)
    .first<{ settings: string }>()
  if (!row?.settings) return []
  let parsed: Record<string, unknown>
  try {
    parsed = typeof row.settings === 'string'
      ? JSON.parse(row.settings)
      : (row.settings as Record<string, unknown>)
  } catch {
    return []
  }
  const blob = parsed.terminology
  if (!Array.isArray(blob)) return []
  return (blob as BlobConcept[]).filter(
    (c): c is BlobConcept & { id: string; sourceTerm: string } =>
      typeof c?.id === 'string' && c.id !== '' &&
      typeof c?.sourceTerm === 'string' && c.sourceTerm.trim() !== '',
  )
}

export interface MigrateConceptsResult {
  /** True when this call found blob concepts and wrote rows for them. */
  migrated: boolean
  /** How many concepts were carried across (0 when there was nothing to do). */
  count: number
}

/**
 * Migrate `project_settings.terminology` into the concepts projection, if it
 * is still there. Safe to call on every read: the common case (already
 * migrated, or never had a termbase) is one small indexed SELECT.
 *
 * Failures are swallowed by the caller, deliberately — see the read route. A
 * migration that cannot run must degrade to "termbase looks empty", never to a
 * failed read of a project's terminology.
 */
export async function migrateProjectConcepts(
  db: AquillaDb,
  projectId: string,
): Promise<MigrateConceptsResult> {
  const concepts = await loadBlobConcepts(db, projectId)
  if (concepts.length === 0) {
    // Either already migrated, never had a termbase, or every entry was junk.
    // Clearing is safe and idempotent in all three cases and makes subsequent
    // reads take the cheap path.
    await clearTerminologyKey(db, projectId)
    return { migrated: false, count: 0 }
  }

  const now = Date.now()
  // One block for the whole migration. Replays consume a block and drop their
  // rows on ON CONFLICT — seq gaps, harmless by design (see event-insert.ts).
  const firstSeq = await allocateSeqRange(db, projectId, concepts.length)

  const stmts: AquillaStatement[] = []
  concepts.forEach((c, i) => {
    const renderings = normalizeRenderings(c.renderings)
    const status = normalizeStatus(c.status)
    // `createdAt` is an ISO string in the blob; the projection stores epoch ms.
    // An unparseable/absent date falls back to now rather than 1970, so a
    // migrated term does not sort to the beginning of time in the UI.
    const createdAt = c.createdAt ? Date.parse(c.createdAt) : NaN
    const created = Number.isFinite(createdAt) ? createdAt : now
    const payload = {
      conceptId: c.id,
      sourceTerm: c.sourceTerm,
      renderings,
      status,
      ...(c.notes ? { notes: c.notes } : {}),
      ...(c.caseSensitive ? { caseSensitive: true } : {}),
    }
    stmts.push(
      buildEventInsertStmt(db, {
        id: migrationEventId(projectId, c.id),
        schemaVersion: 1,
        projectId,
        fileId: null,
        cellId: null,
        parentId: null,
        kind: 'term.create',
        // Preserve who originally added the term where the blob recorded it;
        // the migration is a transport change, not a change of authorship.
        author: c.createdBy || 'migration',
        payloadJson: JSON.stringify(payload),
        clientTs: created,
        serverTs: created,
        serverSeq: firstSeq + i,
      }),
    )
    stmts.push(
      db
        .prepare(
          `INSERT INTO concepts (
            concept_id, project_id, source_term, renderings, notes,
            status, case_sensitive, created_by, created_at, updated_at, deleted_at
          ) VALUES (?, ?, ?, ?::text::jsonb, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(concept_id) DO NOTHING`,
        )
        .bind(
          c.id,
          projectId,
          c.sourceTerm,
          JSON.stringify(renderings),
          c.notes ?? null,
          status,
          c.caseSensitive ? 1 : 0,
          c.createdBy ?? null,
          created,
          created,
        ),
    )
  })

  // CHUNKED, because real termbases are big: the largest on dev carries 961
  // concepts, which is 1922 statements. One batch that size is a bad idea
  // through Hyperdrive regardless of whether it happens to fit — it is a
  // single long transaction holding locks on `events`, the seq counter and
  // `concepts` while an interactive read waits on it.
  //
  // Chunking is safe here for the same reason a re-run is safe: every write is
  // keyed on a derived id, so a partial migration is simply a migration that
  // finishes on the next read. `clearTerminologyKey` runs only after ALL
  // chunks land, so an interrupted run leaves the blob in place and the next
  // reader resumes rather than losing the tail.
  for (let i = 0; i < stmts.length; i += MIGRATION_CHUNK) {
    await db.batch(stmts.slice(i, i + MIGRATION_CHUNK))
  }
  // Only after the rows are durably in. If this fails, the next read simply
  // re-runs the migration and the ON CONFLICTs make it a no-op.
  await clearTerminologyKey(db, projectId)
  return { migrated: true, count: concepts.length }
}

/**
 * Remove the retired `terminology` key from a project's settings blob.
 *
 * Uses jsonb `-` rather than a read-modify-write so it cannot clobber a
 * concurrent settings write to some OTHER key — which would be a fresh
 * instance of the exact bug this whole change set removes. The version column
 * is deliberately NOT bumped: this is a storage migration, not a user edit,
 * and bumping it would 409 an in-flight settings save for no reason.
 *
 * NO `WHERE ... ?  'terminology'` KEY-EXISTS GUARD, AND THERE MUST NOT BE ONE.
 * The Postgres shim rewrites placeholders with a blanket
 * `query.replace(/\?/g, …)` (db/shim/postgres.ts), so jsonb's `?` key-exists
 * operator would be eaten as a bind parameter and the statement would fail at
 * runtime with an argument-count mismatch. Dropping a key that is not there is
 * already a no-op, so the guard bought nothing anyway. The same trap applies
 * to `?|` and `?&` — use `jsonb_exists*()` if one is ever genuinely needed.
 */
async function clearTerminologyKey(db: AquillaDb, projectId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE project_settings
       SET settings = ((settings::jsonb) - 'terminology')::text
       WHERE project_id = ?`,
    )
    .bind(projectId)
    .run()
}

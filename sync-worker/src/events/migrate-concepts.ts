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
// The blob key is removed only when EVERY raw entry was carried. An entry that
// cannot be mapped stays in the array, and a non-array or unparseable settings
// blob is left untouched — deleting either would throw away terms this
// function did not write. Clearing, when it does happen, is after the rows
// are in and is tolerant of having already happened.

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
 * An entry the blob writers actually stored can still fail this: the glossary
 * inline editor commits a cleared or whitespace-only sourceTerm, and TBX
 * import keeps an empty `termEntry` id. Those entries are not concepts, but
 * they are still the user's row and must not be deleted with the key.
 */
function isMappableConcept(
  entry: unknown,
): entry is BlobConcept & { id: string; sourceTerm: string } {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  const concept = entry as BlobConcept
  return typeof concept.id === 'string' && concept.id !== '' &&
    typeof concept.sourceTerm === 'string' && concept.sourceTerm.trim() !== ''
}

/**
 * Statements per batch. Two statements per concept (the event row and the
 * projection row), so 200 is 100 concepts — small enough to keep any single
 * transaction short, large enough that a 961-concept termbase is ten batches
 * rather than a thousand round trips.
 */
const MIGRATION_CHUNK = 200

/**
 * All that reading the blob needs. Narrower than AquillaDb because autopilot's
 * context loader in auth-worker reaches this read through a minimal handle.
 */
export interface SettingsReadDb {
  prepare(query: string): {
    bind(...params: unknown[]): { first<T>(): Promise<T | null> }
  }
}

/**
 * Decode a project's LEGACY blob termbase into the read route's wire shape.
 *
 * Read-only. Used by the concepts read route as a fallback while a project is
 * still unmigrated, so nobody ever sees an empty termbase — see the long note
 * at that call site for why a fallback exists at all and why it does not
 * reopen the concurrent-add bug (the blob is never WRITTEN any more). The
 * in-app agent's term search (auth-worker/src/lib/agent/tools/search.ts) and
 * auth-worker's readProjectConcepts (lib/concepts-read.ts: subscribed
 * termbases and autopilot) import it for the same fallback, so they see what
 * the editor shows.
 *
 * Shares `loadBlobConcepts` with the migration itself, so what a user sees
 * before migration and what lands after it cannot drift apart.
 */
export async function readBlobConcepts(
  db: SettingsReadDb,
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
  db: SettingsReadDb,
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
  return (blob as unknown[]).filter(isMappableConcept)
}

export interface MigrateConceptsResult {
  /** True when this call wrote concept rows from the blob. */
  migrated: boolean
  /** How many concepts were carried across (0 when there was nothing to migrate). */
  count: number
  /**
   * Blob entries left in `terminology` because they could not be mapped.
   * 0 when the key was cleared or there was nothing to carry.
   */
  skipped: number
}

/**
 * Warning for entries left in the blob. Names the project and the skipped
 * count. `scripts/migrate-concepts.ts` prints this from `result.skipped`
 * rather than parsing the settings JSON again.
 */
export function migrationSkipWarning(projectId: string, skipped: number): string {
  const noun = skipped === 1 ? 'entry' : 'entries'
  return (
    `concepts migration: skipped ${skipped} unmigrated blob ${noun} for ${projectId}; ` +
    'terminology key retained'
  )
}

type TerminologyInspection =
  | { kind: 'clearable' }
  | { kind: 'leave' }
  | { kind: 'array'; entries: unknown[] }

/**
 * What the raw `terminology` value is, before any entry is dropped.
 *
 * `clearable` is an absent key or a missing row — removing the key deletes
 * nothing. `leave` is a blob this function must not rewrite: it did not
 * parse, the settings value is not an object, or `terminology` is present
 * and is not an array. `array` is the raw list, including entries that
 * `isMappableConcept` will reject.
 */
async function inspectTerminology(
  db: AquillaDb,
  projectId: string,
): Promise<TerminologyInspection> {
  const row = await db
    .prepare('SELECT settings FROM project_settings WHERE project_id = ?')
    .bind(projectId)
    .first<{ settings: string }>()
  if (!row?.settings) return { kind: 'clearable' }
  let parsed: unknown
  try {
    parsed = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings
  } catch {
    return { kind: 'leave' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'leave' }
  const record = parsed as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(record, 'terminology')) return { kind: 'clearable' }
  const blob = record.terminology
  if (!Array.isArray(blob)) return { kind: 'leave' }
  return { kind: 'array', entries: blob }
}

/**
 * Migrate `project_settings.terminology` into the concepts projection, if it
 * is still there.
 *
 * Not called from the concepts read route. A migrate-on-read of a 961-concept
 * termbase exceeded the Worker budget; a read stays a read
 * (concepts-read-route.ts). `scripts/migrate-concepts.ts` is the caller.
 *
 * The key is deleted only after every raw entry has been written. An entry
 * that cannot be mapped stays in the array, and the call warns with the
 * project id and the skipped count. A value that is present but is not an
 * array, and a settings blob that will not parse, are left in place.
 *
 * A well-formed concept is idempotent: the event id is
 * `migrationEventId(projectId, conceptId)` and the concept insert is
 * `ON CONFLICT DO NOTHING`. A second run after the key is gone writes nothing.
 */
export async function migrateProjectConcepts(
  db: AquillaDb,
  projectId: string,
): Promise<MigrateConceptsResult> {
  const inspection = await inspectTerminology(db, projectId)
  if (inspection.kind === 'leave') {
    return { migrated: false, count: 0, skipped: 0 }
  }
  if (inspection.kind === 'clearable') {
    await clearTerminologyKey(db, projectId)
    return { migrated: false, count: 0, skipped: 0 }
  }
  const entries = inspection.entries
  if (entries.length === 0) {
    await clearTerminologyKey(db, projectId)
    return { migrated: false, count: 0, skipped: 0 }
  }

  const concepts = entries.filter(isMappableConcept)
  const skippedEntries = entries.filter((entry) => !isMappableConcept(entry))
  if (concepts.length === 0) {
    console.warn(migrationSkipWarning(projectId, skippedEntries.length))
    return { migrated: false, count: 0, skipped: skippedEntries.length }
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
  // keyed on a derived id, so a run that stops between chunks leaves the blob
  // in place and the next `scripts/migrate-concepts.ts` invocation resumes.
  // The terminology key is rewritten only after ALL chunks land. This is not
  // on the read path — a read must not pay for the write.
  for (let i = 0; i < stmts.length; i += MIGRATION_CHUNK) {
    await db.batch(stmts.slice(i, i + MIGRATION_CHUNK))
  }
  if (skippedEntries.length === 0) {
    // Only after the rows are durably in. If this fails, the next script run
    // re-executes the migration and the ON CONFLICTs make it a no-op.
    await clearTerminologyKey(db, projectId)
    return { migrated: true, count: concepts.length, skipped: 0 }
  }
  // The rows for the mappable entries are in. Replace the array with only
  // what we could not carry — never delete the key out from under them.
  await retainTerminologyEntries(db, projectId, skippedEntries)
  console.warn(migrationSkipWarning(projectId, skippedEntries.length))
  return { migrated: true, count: concepts.length, skipped: skippedEntries.length }
}

/**
 * Replace `terminology` with the entries this migration did not carry.
 *
 * `jsonb_set` touches that one key inside the database, same reason as
 * `clearTerminologyKey`: a read-modify-write of the whole settings document
 * would clobber a concurrent edit to some other key. The version column is
 * not bumped; this is a storage migration, not a user edit.
 */
async function retainTerminologyEntries(
  db: AquillaDb,
  projectId: string,
  entries: unknown[],
): Promise<void> {
  await db
    .prepare(
      `UPDATE project_settings
       SET settings = jsonb_set((settings::jsonb), '{terminology}', ?::text::jsonb)::text
       WHERE project_id = ?`,
    )
    .bind(JSON.stringify(entries), projectId)
    .run()
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

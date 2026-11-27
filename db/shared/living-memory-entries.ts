// `project_settings.livingMemoryEntries` as ROWS, not a key in the blob.
// (AQU-2719 step 1, first collection)
//
// WHY. `project_settings.settings` is one JSON text column per project that
// the schema comments call multi-MB, and the SPA's save is a whole-blob
// read-modify-write. So every settings read parses the authored living-memory
// entries whether or not it wants them, every save re-serializes them, and
// each of the 28 generated columns parses the same blob once more. Moving a
// collection out shrinks what all of that costs — the same move terminology
// made in AQU-1006 (`sync-worker/src/events/migrate-concepts.ts`).
//
// THE ONE RULE THAT KEEPS THIS SAFE. The key never leaves the API surface.
// `loadProjectSettings` (`db/shared/projects.ts`) puts `livingMemoryEntries`
// back into the settings object it returns, so every reader — the SPA, the
// settings `GET`, inherited settings, the Agent API's `patch_settings`, the
// drafting prompts — sees exactly what it saw before, and a client may still
// send the key back in its whole-blob save. Only the storage moved.
//
// FALLBACK, NOT CUTOVER. A reader may never assume the rows exist. What a
// project reads is the rows UNION whatever is still in the blob, so an
// un-migrated project, a half-migrated one, and an entry this module refused
// to carry all read correctly. That is the same rule the `wp_` columns follow
// in `sync-worker/src/events/request-cache.ts`.
//
// WHEN A PROJECT MOVES. On its next settings SAVE (below), or when an
// operator runs `scripts/migrate-living-memory.ts`. Deliberately NOT on read:
// AQU-1006 measured a migrate-on-read of the largest dev termbase (961
// concepts) past the Worker budget and left reads alone for it, and a read
// that writes would also re-write a multi-MB row under any racing human edit
// — the pathology the `react_cursor` columns were pulled out of the blob to
// avoid (AQU-1846, 0158). A read stays a read.
//
// IDEMPOTENT WITHOUT A LOCK, for the same reason terminology's migration is:
// `entry_id` is the entry's OWN id, minted by the client when the entry was
// authored, so concurrent callers compute identical rows. The insert is
// `ON CONFLICT (entry_id) DO UPDATE` with the values it just computed — an
// edit to an entry's text has to land, and a replay therefore writes the row
// it would have written anyway. A run that dies half way leaves the blob key
// in place, so the project still reads correctly and the next run resumes.

import type { AquillaDb, AquillaStatement } from '../shim/postgres'

/** The settings key this module owns. */
export const LIVING_MEMORY_KEY = 'livingMemoryEntries'

/**
 * All `withLivingMemoryEntries` needs of a database handle. Narrowed so the
 * instructions readers can pass their own `InstructionsDb`-shaped handle
 * (./load-translation-instructions.ts) and a transaction handle
 * (./project-facts-write.ts) without either widening to `AquillaDb`.
 */
export interface LivingMemoryReadDb {
  prepare(query: string): {
    bind(...params: unknown[]): { all<T>(): Promise<{ results: T[] }> }
  }
}

/** Mirrors `LivingMemoryEntry` in src/lib/parsers/types.ts. */
export interface LivingMemoryEntryRecord {
  id: string
  kind: 'instruction' | 'standard'
  text: string
  createdAt: string
  author: string
}

/**
 * How many entry rows one batch carries. Chunked for the reason
 * `migrate-concepts.ts` chunks: one long transaction holding locks on the
 * table while an interactive settings read waits behind it is a bad trade
 * however well it happens to fit.
 */
export const LIVING_MEMORY_CHUNK = 200

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One blob entry as a row, or `null` when it cannot be carried.
 *
 * An entry needs an `id` (it is the row's primary key, and what makes a
 * re-run a no-op) and a string `text`. Everything else is coerced to the
 * column's default rather than rejected: an entry with a damaged `kind` or a
 * missing `author` is still somebody's authored note, and dropping it to tidy
 * a type would lose content the blob was holding fine. A refused entry stays
 * in the blob and keeps being read from there.
 */
export function mappableLivingMemoryEntry(raw: unknown): LivingMemoryEntryRecord | null {
  if (!isPlainObject(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id : null
  const text = typeof raw.text === 'string' ? raw.text : null
  if (!id || id === '' || text === null) return null
  return {
    id,
    kind: raw.kind === 'instruction' ? 'instruction' : 'standard',
    text,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    author: typeof raw.author === 'string' ? raw.author : '',
  }
}

/**
 * The rows the reader's aggregate handed back, or `null` when there is no
 * usable aggregate — which is every caller that does not select it, every
 * test double, and a project with no rows. `null` means "fall back to the
 * blob", never "this project has no entries".
 */
export function rowsToLivingMemoryEntries(raw: unknown): LivingMemoryEntryRecord[] | null {
  const value = typeof raw === 'string' ? safeParse(raw) : raw
  if (!Array.isArray(value)) return null
  const entries = value.flatMap((row) => {
    const entry = mappableLivingMemoryEntry(row)
    return entry ? [entry] : []
  })
  return entries.length > 0 ? entries : null
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * What a project reads for this key: the rows first, then anything still in
 * the blob that the rows do not already carry (matched on entry id).
 *
 * Returns `undefined` when neither source has anything to say, so an absent
 * key stays absent — `project-settings-overlay.ts::assign` ignores an absent
 * value and would keep a stale list, which is why the writer below stores an
 * explicit `[]` rather than dropping the key when the last entry is deleted.
 */
export function mergeLivingMemoryEntries(
  fromRows: LivingMemoryEntryRecord[] | null,
  fromBlob: unknown,
): unknown {
  // A blob value that is not an array is not this module's to interpret: hand
  // it back exactly as stored (and the writer leaves it alone too).
  if (!fromRows) return fromBlob
  if (!Array.isArray(fromBlob)) return fromRows
  const seen = new Set(fromRows.map((entry) => entry.id))
  const leftovers = fromBlob.filter((raw) => {
    const entry = mappableLivingMemoryEntry(raw)
    // An unmappable leftover has no id to match on, so it is always kept.
    return entry ? !seen.has(entry.id) : true
  })
  return leftovers.length > 0 ? [...fromRows, ...leftovers] : fromRows
}

/**
 * The SQL fragment `loadProjectSettings` selects alongside the settings row —
 * one correlated aggregate, so reading a project's entries costs no extra
 * round-trip. Ordered by `sort_index` so the array order the blob expressed
 * survives the move.
 *
 * No jsonb `?` operator here, and there must not be one: the Postgres shim
 * rewrites placeholders with a blanket `query.replace(/\?/g, …)`
 * (`db/shim/postgres.ts`), so `?` as the key-exists operator is eaten as a
 * bind parameter and the statement fails on an argument-count mismatch.
 */
export const LIVING_MEMORY_SELECT = `(
    SELECT jsonb_agg(jsonb_build_object(
             'id', e.entry_id,
             'kind', e.kind,
             'text', e.text,
             'createdAt', e.created_at,
             'author', e.author
           ) ORDER BY e.sort_index, e.entry_id)
      FROM project_living_memory_entries e
     WHERE e.project_id = ps.project_id
  ) AS living_memory_entries`

/** What a settings write should do with this key. */
export type LivingMemoryWritePlan =
  | {
      /** Leave the rows and the blob key exactly as they are. */
      kind: 'untouched'
    }
  | {
      /**
       * This write owns the rows: replace the project's set with `entries`,
       * and store `blobValue` under the key (an empty array, or nothing at
       * all once the entries live in rows).
       */
      kind: 'project'
      entries: LivingMemoryEntryRecord[]
      /** `[]` to keep the key present and empty, or `undefined` to drop it. */
      blobValue: unknown[] | undefined
      /** Entries the move refused to carry; they stay in the blob. */
      retained: unknown[]
    }

/**
 * Decide what a settings write does with `livingMemoryEntries`.
 *
 * `before` is the effective value the writer loaded (rows already merged in),
 * `after` the value the client is storing.
 *
 * - A value that is not an array is left alone, both in the rows and in the
 *   blob. Rewriting it would be this module guessing at content it does not
 *   understand.
 * - An empty array on a project that had nothing is left alone too: there is
 *   nothing to move, and synthesizing rows or clearing a key nobody wrote
 *   would change what the next read returns.
 * - Otherwise the rows become the truth for this project. An entry that
 *   cannot be carried is kept in the blob so no content is lost.
 */
export function planLivingMemoryWrite(before: unknown, after: unknown): LivingMemoryWritePlan {
  if (!Array.isArray(after)) return { kind: 'untouched' }
  const hadSomething = Array.isArray(before) ? before.length > 0 : before != null
  if (after.length === 0 && !hadSomething) return { kind: 'untouched' }

  const entries: LivingMemoryEntryRecord[] = []
  const retained: unknown[] = []
  const seen = new Set<string>()
  for (const raw of after) {
    const entry = mappableLivingMemoryEntry(raw)
    // A duplicate id cannot become a second row (entry_id is the key), so the
    // later copy is retained in the blob rather than silently dropped.
    if (!entry || seen.has(entry.id)) {
      retained.push(raw)
      continue
    }
    seen.add(entry.id)
    entries.push(entry)
  }
  return {
    kind: 'project',
    entries,
    // Keep the key present and empty when nothing is going to rows, so a
    // client that just deleted its last entry sees `[]` and not an absent
    // key its overlay would ignore.
    blobValue: entries.length === 0 || retained.length > 0 ? retained : undefined,
    retained,
  }
}

/**
 * Statements that make `entries` the project's whole set, to run in the SAME
 * batch as the settings write.
 *
 * `guardSql` / `guardBind` are the caller's "the settings row I just wrote is
 * still the stored one" guard (see `validationProjectionStmts` in
 * `db/shared/projects.ts`). Both the delete and every insert carry it, so a
 * write that lost its version race leaves the rows untouched instead of
 * replacing them from a blob that was never stored.
 */
export function livingMemoryWriteStmts(
  db: AquillaDb,
  projectId: string,
  entries: LivingMemoryEntryRecord[],
  guardSql: string,
  guardBind: unknown[],
): AquillaStatement[] {
  const stmts: AquillaStatement[] = [
    db
      .prepare(
        `DELETE FROM project_living_memory_entries
          WHERE project_id = ? AND ${guardSql}`,
      )
      .bind(projectId, ...guardBind),
  ]
  entries.forEach((entry, index) => {
    stmts.push(
      db
        .prepare(
          `INSERT INTO project_living_memory_entries
             (entry_id, project_id, kind, text, author, created_at, sort_index)
           SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE ${guardSql}
           ON CONFLICT (entry_id) DO UPDATE SET
             project_id = excluded.project_id,
             kind       = excluded.kind,
             text       = excluded.text,
             author     = excluded.author,
             created_at = excluded.created_at,
             sort_index = excluded.sort_index`,
        )
        .bind(
          entry.id,
          projectId,
          entry.kind,
          entry.text,
          entry.author,
          entry.createdAt,
          index,
          ...guardBind,
        ),
    )
  })
  return stmts
}

export interface MigrateLivingMemoryResult {
  /** True when this call wrote entry rows from the blob. */
  migrated: boolean
  /** How many entries were carried across. */
  count: number
  /** Blob entries left under the key because they could not be carried. */
  skipped: number
}

/**
 * Warning for entries left in the blob. `scripts/migrate-living-memory.ts`
 * prints this from `result.skipped` rather than parsing the settings again.
 */
export function livingMemorySkipWarning(projectId: string, skipped: number): string {
  const noun = skipped === 1 ? 'entry' : 'entries'
  return (
    `living-memory migration: skipped ${skipped} uncarried blob ${noun} for ${projectId}; ` +
    `${LIVING_MEMORY_KEY} key retained`
  )
}

type BlobInspection =
  | { kind: 'nothing' }
  | { kind: 'leave' }
  | { kind: 'array'; entries: unknown[] }

/**
 * What the raw blob value is, before any entry is refused.
 *
 * `nothing` is an absent key or a missing row. `leave` is a blob this
 * function must not rewrite: it did not parse, it is not an object, or the key
 * is present and is not an array. `array` is the raw list.
 */
async function inspectBlob(db: AquillaDb, projectId: string): Promise<BlobInspection> {
  const row = await db
    .prepare(`SELECT settings FROM project_settings WHERE project_id = ?`)
    .bind(projectId)
    .first<{ settings: string }>()
  if (!row?.settings) return { kind: 'nothing' }
  let parsed: unknown
  try {
    parsed = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings
  } catch {
    return { kind: 'leave' }
  }
  if (!isPlainObject(parsed)) return { kind: 'leave' }
  if (!Object.prototype.hasOwnProperty.call(parsed, LIVING_MEMORY_KEY)) return { kind: 'nothing' }
  const blob = parsed[LIVING_MEMORY_KEY]
  if (!Array.isArray(blob)) return { kind: 'leave' }
  return { kind: 'array', entries: blob }
}

/**
 * Move a project's `livingMemoryEntries` out of the blob and into rows.
 *
 * The backfill half of this change: `scripts/migrate-living-memory.ts` calls
 * it for projects nobody saves, and it shares the whole code path with the
 * save-triggered move so there is no second implementation to drift.
 *
 * Safe to re-run and safe to interrupt. The rows go in first and the key is
 * only then rewritten, so a crash in between leaves a project that still
 * reads correctly from the blob and migrates on the next run.
 */
export async function migrateProjectLivingMemory(
  db: AquillaDb,
  projectId: string,
): Promise<MigrateLivingMemoryResult> {
  const inspection = await inspectBlob(db, projectId)
  if (inspection.kind === 'leave' || inspection.kind === 'nothing') {
    return { migrated: false, count: 0, skipped: 0 }
  }
  const plan = planLivingMemoryWrite(inspection.entries, inspection.entries)
  if (plan.kind === 'untouched' || plan.entries.length === 0) {
    // An empty key, or nothing carryable. Either way the blob stays as it is:
    // there are no bytes to win and no rows to write.
    return { migrated: false, count: 0, skipped: plan.kind === 'untouched' ? 0 : plan.retained.length }
  }

  // No guard: this is not racing a settings write of its own, and the insert's
  // ON CONFLICT already makes a replay a no-op. `TRUE` keeps one statement
  // shape shared with the write path.
  const stmts = livingMemoryWriteStmts(db, projectId, plan.entries, 'TRUE', [])
  for (let i = 0; i < stmts.length; i += LIVING_MEMORY_CHUNK) {
    await db.batch(stmts.slice(i, i + LIVING_MEMORY_CHUNK))
  }

  // Only now that the rows are durably in. `jsonb_set`/`-` touch the one key
  // inside the database rather than read-modify-writing the whole document,
  // which would clobber a concurrent edit to another key — the exact bug this
  // change set exists to stop. The version column is deliberately NOT bumped:
  // a storage migration is not a user edit, and bumping it would 409 an
  // in-flight settings save for no reason.
  if (plan.retained.length > 0) {
    await db
      .prepare(
        `UPDATE project_settings
            SET settings = jsonb_set((settings::jsonb), '{${LIVING_MEMORY_KEY}}', ?::text::jsonb)::text
          WHERE project_id = ?`,
      )
      .bind(JSON.stringify(plan.retained), projectId)
      .run()
    console.warn(livingMemorySkipWarning(projectId, plan.retained.length))
  } else {
    await db
      .prepare(
        `UPDATE project_settings
            SET settings = ((settings::jsonb) - '${LIVING_MEMORY_KEY}')::text
          WHERE project_id = ?`,
      )
      .bind(projectId)
      .run()
  }
  return { migrated: true, count: plan.entries.length, skipped: plan.retained.length }
}

/**
 * Merge a project's entry rows into a settings object a caller read with its
 * OWN `SELECT settings` — the readers that do not go through
 * `loadProjectSettings` and so never get the key put back for them.
 *
 * There are only two, both on the instructions path, and both reach the key
 * through `resolveTranslationInstructions`: `loadTranslationInstructions`
 * (./load-translation-instructions.ts) and `currentInstructions`
 * (./project-facts-write.ts). Anything else that reads the blob directly does
 * not name this key — checked across both workers for AQU-2719, and the
 * reason this helper exists rather than a second copy of the merge rule.
 *
 * Returns a COPY. A caller that writes its object back to the blob must keep
 * writing the one it read, or it would put the entries back in the blob.
 */
export async function withLivingMemoryEntries(
  db: LivingMemoryReadDb,
  projectId: string,
  settings: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let entries: LivingMemoryEntryRecord[] | null = null
  try {
    const rows = await db
      .prepare(
        `SELECT entry_id, kind, text, author, created_at
           FROM project_living_memory_entries
          WHERE project_id = ?
          ORDER BY sort_index, entry_id`,
      )
      .bind(projectId)
      .all<{ entry_id: string; kind: string; text: string; author: string; created_at: string }>()
    entries = rowsToLivingMemoryEntries(
      (rows.results ?? []).map((row) => ({
        id: row.entry_id,
        kind: row.kind,
        text: row.text,
        author: row.author,
        createdAt: row.created_at,
      })),
    )
  } catch (err) {
    // The rows are an optimization, never the only copy a caller can reach.
    // A failed lookup falls back to the blob, which is the same answer an
    // un-migrated project gives, rather than failing a drafting read.
    console.error('[living-memory] row read failed:', err)
    return settings
  }
  const merged = mergeLivingMemoryEntries(entries, settings[LIVING_MEMORY_KEY])
  if (merged === undefined) return settings
  return { ...settings, [LIVING_MEMORY_KEY]: merged }
}

/**
 * Does this project have entry rows at all?
 *
 * Asked only when a save's entries are UNCHANGED, to tell "already moved,
 * leave the rows alone" from "not moved yet, this save is the move". One
 * indexed existence check, which is what keeps the common case — the SPA
 * echoing the key back on a save that changed some other setting — from
 * replacing every entry row for nothing. `batch()` runs its statements
 * sequentially on one connection, so that would be one round-trip per entry.
 */
export async function livingMemoryRowsExist(
  db: LivingMemoryReadDb,
  projectId: string,
): Promise<boolean> {
  try {
    const rows = await db
      .prepare(
        `SELECT 1 AS present
           FROM project_living_memory_entries
          WHERE project_id = ?
          LIMIT 1`,
      )
      .bind(projectId)
      .all<{ present: number }>()
    return (rows.results ?? []).length > 0
  } catch (err) {
    // Unknown → treat as not moved, so the save writes the rows. Writing them
    // again is harmless (the insert upserts the same values); skipping a move
    // that never happened would leave the key in the blob forever.
    console.error('[living-memory] row probe failed:', err)
    return false
  }
}

/** Projects that still carry the key in their blob, for the backfill script. */
export async function projectsWithBlobLivingMemory(db: AquillaDb): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT project_id
         FROM project_settings
        WHERE jsonb_exists((settings::jsonb), '${LIVING_MEMORY_KEY}')
        ORDER BY project_id`,
    )
    .all<{ project_id: string }>()
  return (rows.results ?? []).map((row) => row.project_id)
}

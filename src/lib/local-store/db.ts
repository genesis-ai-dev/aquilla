/**
 * Client-side local store backed by SQLite-WASM.
 *
 * Two storage backends, picked by the `name` option:
 *   - `":memory:"`     in-process db, no persistence. Used in unit tests
 *                      and as a fallback when OPFS is unavailable.
 *   - any other string OPFS-backed db at `<name>.sqlite3` under the page's
 *                      origin. Survives reload, scoped to the project.
 *
 * See docs/DATA_PERSISTENCE_PLAN.md §2 (storage tiers) and §13 (migrations).
 */

import {
  openMemoryBackend,
  openOpfsBackend,
  type SqliteBackend,
} from "./db-backends"
import type { Migration } from "./migrations"

/**
 * Thrown when a migration's content hash differs from what was recorded the
 * first time it was applied. See DATA_PERSISTENCE_PLAN.md §13 — migration
 * files are append-only; editing one after deploy is a critical bug.
 *
 * Recovery is "wipe local store and re-bootstrap from server snapshot."
 */
export class MigrationDriftError extends Error {
  readonly version: number
  readonly stored: string
  readonly current: string
  constructor(version: number, stored: string, current: string) {
    super(
      `migration ${version} content hash drift — recorded ${stored.slice(0, 8)}…, now ${current.slice(0, 8)}…. Migration files are append-only after deploy.`,
    )
    this.name = "MigrationDriftError"
    this.version = version
    this.stored = stored
    this.current = current
  }
}

export interface LocalStoreOptions {
  /**
   * Database identifier. Use `":memory:"` for tests and ephemeral stores;
   * any other string for an OPFS-backed persistent database scoped under
   * `<name>.sqlite3` in the page's origin storage.
   */
  name: string
}

export class LocalStore {
  private readonly backend: SqliteBackend
  private constructor(backend: SqliteBackend) {
    this.backend = backend
  }

  static async open(opts: LocalStoreOptions): Promise<LocalStore> {
    const backend =
      opts.name === ":memory:"
        ? await openMemoryBackend()
        : await openOpfsBackend(opts.name)
    return new LocalStore(backend)
  }

  async run(sql: string, params?: ReadonlyArray<unknown>): Promise<void> {
    await this.backend.run(sql, params)
  }

  async query<T>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]> {
    return this.backend.query<T>(sql, params)
  }

  async close(): Promise<void> {
    await this.backend.close()
  }

  /**
   * Run `fn` inside a SQLite transaction. Commits if `fn` resolves; rolls
   * back if it throws. Only one transaction at a time — SQLite-WASM has a
   * single-writer model and we don't open savepoints.
   */
  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.run("BEGIN")
    try {
      const result = await fn()
      await this.run("COMMIT")
      return result
    } catch (e) {
      await this.run("ROLLBACK")
      throw e
    }
  }

  /**
   * Apply migrations that haven't been applied yet, in ascending version order.
   *
   * Each migration is applied inside a transaction together with its
   * `_migrations` row insert, so a partial failure (page close, malformed
   * SQL) leaves the database in its pre-migration state.
   *
   * Each `_migrations` row records a SHA-256 hash of the canonicalized SQL.
   * On every subsequent open we recompute the hash for already-applied
   * migrations and compare. Mismatch throws `MigrationDriftError` — the
   * tripwire for the most common migration disaster (editing a migration
   * file in place after it has shipped). See DATA_PERSISTENCE_PLAN.md §13.
   */
  async migrate(migrations: ReadonlyArray<Migration>): Promise<void> {
    await this.run(
      `CREATE TABLE IF NOT EXISTS _migrations (
         version INTEGER PRIMARY KEY,
         applied_at INTEGER NOT NULL,
         content_hash TEXT NOT NULL
       )`,
    )
    const applied = await this.query<{ version: number; content_hash: string }>(
      "SELECT version, content_hash FROM _migrations",
    )
    const appliedHash = new Map(applied.map((r) => [r.version, r.content_hash]))

    const sorted = [...migrations].sort((a, b) => a.version - b.version)
    for (const m of sorted) {
      const hash = await hashMigrationSql(m.sql)
      const stored = appliedHash.get(m.version)
      if (stored !== undefined) {
        if (stored !== hash) {
          throw new MigrationDriftError(m.version, stored, hash)
        }
        continue
      }
      await this.transaction(async () => {
        await this.run(m.sql)
        await this.run(
          "INSERT INTO _migrations (version, applied_at, content_hash) VALUES (?, ?, ?)",
          [m.version, Date.now(), hash],
        )
      })
    }
  }
}

async function hashMigrationSql(sql: string): Promise<string> {
  const canonical = sql.replace(/\r\n/g, "\n").trim()
  const data = new TextEncoder().encode(canonical)
  const buffer = await globalThis.crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

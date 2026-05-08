/**
 * Client-side local store backed by SQLite-WASM.
 *
 * In tests: pass `name: ":memory:"` for an isolated in-memory database.
 * In the browser: pass a stable name; OPFS persistence is added in a
 * follow-up step.
 *
 * See docs/DATA_PERSISTENCE_PLAN.md §2 (Storage tiers) and §8.6 (outbox).
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import type {
  Database as Sqlite3DB,
  Sqlite3Static,
} from "@sqlite.org/sqlite-wasm"

import type { Migration } from "./migrations"

/**
 * Thrown when a migration's content hash differs from what was recorded the
 * first time it was applied. See DATA_PERSISTENCE_PLAN.md §13 — migration
 * files are append-only; editing one after deploy is a critical bug.
 *
 * Recovery is "wipe local store and re-bootstrap from server snapshot."
 */
export class MigrationDriftError extends Error {
  constructor(
    public readonly version: number,
    public readonly stored: string,
    public readonly current: string,
  ) {
    super(
      `migration ${version} content hash drift — recorded ${stored.slice(0, 8)}…, now ${current.slice(0, 8)}…. Migration files are append-only after deploy.`,
    )
    this.name = "MigrationDriftError"
  }
}

let sqlite3Promise: Promise<Sqlite3Static> | null = null

function getSqlite3(): Promise<Sqlite3Static> {
  if (!sqlite3Promise) {
    sqlite3Promise = sqlite3InitModule({
      print: () => {},
      printErr: () => {},
    })
  }
  return sqlite3Promise
}

export interface LocalStoreOptions {
  /**
   * Database identifier. Currently always opens an in-memory database
   * regardless of the name; the name parameter exists for the OPFS path
   * (per-project persistent storage) which lands in a follow-up commit.
   * Tests should pass `":memory:"` for clarity.
   */
  name: string
}

export class LocalStore {
  private constructor(private readonly db: Sqlite3DB) {}

  static async open(opts: LocalStoreOptions): Promise<LocalStore> {
    const sqlite3 = await getSqlite3()
    const db = new sqlite3.oo1.DB(opts.name, "ct")
    return new LocalStore(db)
  }

  async run(sql: string, params?: ReadonlyArray<unknown>): Promise<void> {
    this.db["exec"]({ sql, bind: params as never })
  }

  async query<T>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]> {
    const rows: T[] = []
    this.db["exec"]({
      sql,
      bind: params as never,
      rowMode: "object",
      resultRows: rows as never,
    })
    return rows
  }

  async close(): Promise<void> {
    this.db.close()
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
   * `_migrations` row, so a partial failure (network drop, page close,
   * malformed SQL) leaves the database in its pre-migration state.
   *
   * Each `_migrations` row records a SHA-256 hash of the canonicalized SQL.
   * On every subsequent open we recompute the hash for already-applied
   * migrations and throw `MigrationDriftError` on mismatch — this is the
   * tripwire for the most common migration disaster (editing a migration
   * file in place after it has shipped to users). See
   * DATA_PERSISTENCE_PLAN.md §13 for the full policy.
   */
  async migrate(migrations: ReadonlyArray<Migration>): Promise<void> {
    this.db["exec"]({
      sql: `CREATE TABLE IF NOT EXISTS _migrations (
              version INTEGER PRIMARY KEY,
              applied_at INTEGER NOT NULL,
              content_hash TEXT NOT NULL
            )`,
    })
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
        this.db["exec"]({ sql: m.sql })
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

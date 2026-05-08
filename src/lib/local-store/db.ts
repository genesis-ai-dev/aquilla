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
   * Database identifier. Use `":memory:"` for tests or transient stores;
   * a stable per-project string for OPFS-backed production storage.
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
   * Apply migrations that haven't been applied yet, in ascending version order.
   * Idempotent: re-applying a migration that has already run is a no-op.
   */
  async migrate(migrations: ReadonlyArray<Migration>): Promise<void> {
    this.db["exec"]({
      sql: `CREATE TABLE IF NOT EXISTS _migrations (
              version INTEGER PRIMARY KEY,
              applied_at INTEGER NOT NULL
            )`,
    })
    const applied = await this.query<{ version: number }>(
      "SELECT version FROM _migrations",
    )
    const appliedSet = new Set(applied.map((r) => r.version))
    const pending = [...migrations]
      .filter((m) => !appliedSet.has(m.version))
      .sort((a, b) => a.version - b.version)
    for (const m of pending) {
      this.db["exec"]({ sql: m.sql })
      this.db["exec"]({
        sql: "INSERT INTO _migrations (version, applied_at) VALUES (?, ?)",
        bind: [m.version, Date.now()],
      })
    }
  }
}

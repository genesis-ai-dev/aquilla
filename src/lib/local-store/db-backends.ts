/**
 * Storage backends behind LocalStore. Two flavors:
 *
 *   - MemoryBackend   in-process oo1.DB. Tests + `:memory:` callers.
 *   - OpfsBackend     sqlite3 worker speaking OPFS-VFS. Browser, persistent.
 *
 * Both expose the same async surface: run / query / close. The LocalStore
 * class doesn't know which one it has, so the rest of the codebase stays
 * environment-agnostic.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import {
  sqlite3Worker1Promiser,
  type Database as Sqlite3DB,
  type Sqlite3Static,
  type Worker1Promiser,
} from "@sqlite.org/sqlite-wasm"

export interface SqliteBackend {
  run(sql: string, params?: ReadonlyArray<unknown>): Promise<void>
  query<T>(sql: string, params?: ReadonlyArray<unknown>): Promise<T[]>
  close(): Promise<void>
}

/* ────────────────────────────  in-memory  ────────────────────────────── */

let sqlite3Promise: Promise<Sqlite3Static> | null = null
function getSqlite3(): Promise<Sqlite3Static> {
  if (!sqlite3Promise) {
    // Newer @sqlite.org/sqlite-wasm types declared init as zero-arg; the
    // runtime accepts a config (print/printErr) for log routing. Bypass
    // the typed signature.
    const init = sqlite3InitModule as unknown as (
      cfg?: { print?: (...a: unknown[]) => void; printErr?: (...a: unknown[]) => void },
    ) => Promise<Sqlite3Static>
    sqlite3Promise = init({ print: () => {}, printErr: () => {} })
  }
  return sqlite3Promise
}

export async function openMemoryBackend(): Promise<SqliteBackend> {
  const sqlite3 = await getSqlite3()
  const db = new sqlite3.oo1.DB(":memory:", "ct")
  return makeMemoryBackend(db)
}

function makeMemoryBackend(db: Sqlite3DB): SqliteBackend {
  return {
    async run(sql: string, params?: ReadonlyArray<unknown>) {
      db["exec"]({ sql, bind: params as never })
    },
    async query<T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<T[]> {
      const rows: T[] = []
      db["exec"]({
        sql,
        bind: params as never,
        rowMode: "object",
        resultRows: rows as never,
      })
      return rows
    },
    async close() {
      db.close()
    },
  }
}

/* ──────────────────────────────  OPFS  ───────────────────────────────── */

let promiserPromise: Promise<Worker1Promiser> | null = null
function getPromiser(): Promise<Worker1Promiser> {
  if (!promiserPromise) {
    // The ESM-default export of `sqlite3Worker1Promiser` is the v2 (promise-
    // returning) form — calling it directly returns Promise<Worker1Promiser>.
    // The `.v2` property only exists on the global form (which the package
    // explicitly deletes for module consumers).
    //
    // The package's defaultConfig.worker uses `new URL("sqlite3-worker1.mjs",
    // import.meta.url)`. Once Vite bundles the package's source into our
    // app chunk, `import.meta.url` resolves to the chunk's path and the
    // file lookup misses. We sidestep this by vendoring the worker + its
    // sqlite3.wasm + opfs-async-proxy into `public/` and passing an explicit
    // worker constructor. The three files must stay co-located so the
    // worker's own relative imports (`sqlite3.wasm`, `sqlite3-opfs-async-
    // proxy.js`) resolve at the same origin path.
    promiserPromise = (
      sqlite3Worker1Promiser as unknown as (
        config?: { worker?: () => Worker },
      ) => Promise<Worker1Promiser>
    )({
      worker: () =>
        new Worker("/sqlite3-worker1.mjs", { type: "module" }),
    })
  }
  return promiserPromise
}

/**
 * Open an OPFS-backed database. The `name` becomes part of the OPFS file
 * path under the page's origin: `<name>.sqlite3`. Two opens with the same
 * name return independent backend wrappers but share the same persisted
 * file (SQLite serializes writes via the worker).
 */
export async function openOpfsBackend(name: string): Promise<SqliteBackend> {
  const promiser = await getPromiser()
  const opened = await promiser("open", {
    filename: `file:${name}.sqlite3?vfs=opfs`,
  })
  const dbId = opened.result.dbId

  // The Worker1 promiser types declare narrow shapes that don't reflect the
  // actual runtime API (which accepts dbId on every call). Cast through
  // `unknown` so the types-vs-runtime gap doesn't bleed into call sites.
  const rawPromiser = promiser as unknown as (
    op: string,
    args: Record<string, unknown>,
  ) => Promise<{ result?: { resultRows?: unknown[] } }>
  return {
    async run(sql: string, params?: ReadonlyArray<unknown>) {
      await rawPromiser("exec", { dbId, sql, bind: params })
    },
    async query<T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<T[]> {
      const rows: unknown[] = []
      const result = await rawPromiser("exec", {
        dbId,
        sql,
        bind: params,
        rowMode: "object",
        resultRows: rows,
      })
      const echoed = result.result?.resultRows
      return ((echoed ?? rows) as T[]).slice()
    },
    async close() {
      await rawPromiser("close", { dbId })
    },
  }
}

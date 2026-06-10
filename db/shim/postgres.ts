// The Aquilla database handle: Postgres (Neon), presented through a small
// statement/batch API that the workers' ~80 routes use as `env.AQUILLA_PG`.
//
// Routes speak a compact SQL surface (`prepare().bind().run()/all()/first()`,
// `batch()`, `exec()`); this module implements that surface (`AquillaDb`)
// directly over Postgres, so a route never touches a raw driver.
//
// Executor-agnostic: prod uses postgres.js over Hyperdrive (`makePostgres`),
// tests use PGlite (real Postgres in WASM) via a `PgExecutor` adapter — so
// tests exercise the exact same code + real dialect.
//
// Two dialect details handled here:
//   1. placeholders — `?` → Postgres `$1,$2,…`  (translated below)
//   2. return types — BIGINT/NUMERIC come back as JS numbers and
//      TIMESTAMP/TIMESTAMPTZ as strings (the postgres.js executor overrides
//      parsers), so callers get numbers and ISO-ish strings, not bigints.
//
// NOT handled here (fixed in the SQL itself): `INSERT OR IGNORE` →
// `ON CONFLICT DO NOTHING`, FTS `MATCH` → `@@ tsquery`, etc.
//
// Caveat: `?`→`$n` is textual; it assumes `?` appears only as a placeholder
// (true for this codebase — string literals use single quotes).
//
// RLS / identity threading (FRO-289)
// ------------------------------------
// In production, workers connect as the `app_runtime` Postgres role (see
// db/postgres/migrations/0034_rls_backstop.sql).  RLS policies on the
// project-scoped tables read `current_setting('app.user_id', true)` to
// determine which rows are visible.
//
// Two entry points control identity:
//
//   db.withUser(userId)  — returns a new PostgresDb whose every query
//     wraps in a transaction with `SET LOCAL app.user_id = '<userId>'`.
//     Use for every authenticated request.
//
//   db.asAdmin()  — returns a new PostgresDb that runs with
//     `SET LOCAL app.user_id = ''`, bypassing identity-gated RLS.
//     For identity-less code paths (migration helpers, rebuild,
//     diarization callback, admin routes that already run as the owner
//     role on Neon).  Must be called explicitly; never used implicitly.
//
// Implementation note: `SET LOCAL` is transaction-scoped.  Because routes
// mostly use individual prepare().bind().run() calls (not batch()), every
// query execution wraps in a mini-transaction to make SET LOCAL effective.
// This is correct with Hyperdrive connection pooling: the SET LOCAL is
// never visible to a different request's connection.

import postgres from "postgres"

/** Result metadata returned alongside every statement's rows. */
export interface AquillaMeta {
  changes: number
  rows_written: number
  rows_read: number
  last_row_id: number
  duration: number
  served_by: string
}

/** Shape returned by `.all()` / `.run()` / each `batch()` entry. */
export interface AquillaResult<T = Record<string, unknown>> {
  results: T[]
  success: true
  meta: AquillaMeta
}

/** A bound (or bindable) SQL statement. */
export interface AquillaStatement {
  bind(...args: unknown[]): AquillaStatement
  all<T = Record<string, unknown>>(): Promise<AquillaResult<T>>
  run<T = Record<string, unknown>>(): Promise<AquillaResult<T>>
  first<T = unknown>(colName?: string): Promise<T | null>
  raw<T = unknown[]>(): Promise<T[]>
}

/** The database handle the workers inject as `env.AQUILLA_PG`. */
export interface AquillaDb {
  prepare(query: string): AquillaStatement
  batch<T = Record<string, unknown>>(stmts: AquillaStatement[]): Promise<AquillaResult<T>[]>
  exec(query: string): Promise<{ count: number; duration: number }>
  close(): Promise<void>
}

/** Minimal neutral executor the handle runs against (postgres.js or PGlite). */
export interface PgExecutor {
  run(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>
  begin<T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T>
  /** Release the underlying connection (postgres.js per-request); no-op for PGlite tests. */
  close?(): Promise<void>
}

/** `?` placeholders → Postgres `$1,$2,…` (positional, in order). */
function toPg(query: string): string {
  let i = 0
  return query.replace(/\?/g, () => `$${++i}`)
}

function meta(rowCount: number, rowsRead: number): AquillaMeta {
  return { changes: rowCount, rows_written: rowCount, rows_read: rowsRead, last_row_id: 0, duration: 0, served_by: "shim" }
}

/** Identity mode for RLS threading. */
type IdentityMode =
  | { kind: "none" }                  // no identity — bare db handle, no SET LOCAL
  | { kind: "user"; userId: string }  // authenticated user path
  | { kind: "admin" }                 // explicit admin bypass

/**
 * Apply the identity SET LOCAL inside a transaction, then call `fn`.
 * Used by both batch() and individual query calls when identity is set.
 */
async function withIdentity<T>(
  executor: PgExecutor,
  mode: IdentityMode,
  fn: (tx: PgExecutor) => Promise<T>,
): Promise<T> {
  return executor.begin(async (tx) => {
    if (mode.kind === "user") {
      // SET LOCAL does not accept bind parameters ($1) in any Postgres version
      // (GUC assignment syntax).  userId is always a String(numericId) coming
      // from withUser() — numeric, safe to embed directly.
      await tx.run(`SET LOCAL app.user_id = '${mode.userId}'`, [])
    } else if (mode.kind === "admin") {
      await tx.run("SET LOCAL app.user_id = ''", [])
    }
    // kind === "none": no SET LOCAL — bare executor (identity-less, no RLS in tests)
    return fn(tx)
  })
}

class PgStatement implements AquillaStatement {
  private executor: PgExecutor
  private mode: IdentityMode
  private query: string
  private args: unknown[]

  constructor(executor: PgExecutor, mode: IdentityMode, query: string, args: unknown[] = []) {
    this.executor = executor
    this.mode = mode
    this.query = query
    this.args = args
  }

  bind(...args: unknown[]): PgStatement {
    return new PgStatement(this.executor, this.mode, this.query, args)
  }

  private async runQuery(): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const pgQuery = toPg(this.query)
    const args = this.args
    if (this.mode.kind === "none") {
      return this.executor.run(pgQuery, args)
    }
    // Wrap in a transaction so SET LOCAL takes effect.
    return withIdentity(this.executor, this.mode, (tx) => tx.run(pgQuery, args))
  }

  async all<T = Record<string, unknown>>(): Promise<AquillaResult<T>> {
    const { rows, rowCount } = await this.runQuery()
    return { results: rows as unknown as T[], success: true as const, meta: meta(rowCount, rows.length) }
  }

  // `.run()` mirrors `.all()` shape (results may be empty for writes).
  async run<T = Record<string, unknown>>(): Promise<AquillaResult<T>> {
    return this.all<T>()
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const { rows } = await this.runQuery()
    const row = rows[0]
    if (row == null) return null
    return (colName != null ? (row[colName] as T) : (row as unknown as T))
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const { rows } = await this.runQuery()
    return rows.map((r) => Object.values(r) as unknown as T)
  }

  /** Re-bind this statement onto a specific executor (used inside batch). */
  _on(tx: PgExecutor) {
    return new PgStatement(tx, { kind: "none" }, this.query, this.args)
  }
}

export class PostgresDb implements AquillaDb {
  private executor: PgExecutor
  private mode: IdentityMode

  constructor(executor: PgExecutor, mode: IdentityMode = { kind: "none" }) {
    this.executor = executor
    this.mode = mode
  }

  /**
   * Return a new handle that threads the given numeric user id into every
   * query via `SET LOCAL app.user_id = '<userId>'` (inside a transaction).
   * Use at the request boundary for all authenticated paths.
   *
   * Pass null to explicitly clear a previously set identity (reverts to
   * bare handle — no SET LOCAL, no RLS enforcement).
   */
  withUser(userId: number | string | null): PostgresDb {
    if (userId == null) return new PostgresDb(this.executor, { kind: "none" })
    return new PostgresDb(this.executor, { kind: "user", userId: String(userId) })
  }

  /**
   * Return a new handle that runs every query with `SET LOCAL app.user_id = ''`,
   * bypassing identity-gated RLS.  Callers MUST already be authorised through
   * a non-DB mechanism (SYNC_SECRET_KEY, DIARIZATION_SHARED_SECRET,
   * PLATFORM_ADMINS gate, etc.).
   *
   * Named call sites (FRO-289 audit — see db/postgres/RLS.md §Named asAdmin call sites):
   *   sync-worker: rebuild, rebuild-fts, migrate-*, import, import-morph,
   *                diarization callback, admin/files
   *   auth-worker: routes/admin.ts (platform-admin cross-tenant reads)
   */
  asAdmin(): PostgresDb {
    return new PostgresDb(this.executor, { kind: "admin" })
  }

  prepare(query: string): PgStatement {
    return new PgStatement(this.executor, this.mode, query)
  }

  /** One batch = one atomic transaction; returns one result per statement. */
  async batch<T = Record<string, unknown>>(stmts: AquillaStatement[]): Promise<AquillaResult<T>[]> {
    const run = async (tx: PgExecutor): Promise<AquillaResult<T>[]> => {
      const out: AquillaResult<T>[] = []
      for (const s of stmts) out.push(await (s as PgStatement)._on(tx).all<T>())
      return out
    }
    if (this.mode.kind === "none") {
      return this.executor.begin(run)
    }
    return withIdentity(this.executor, this.mode, run)
  }

  /** Run statements with no bound params. */
  async exec(query: string) {
    const { rowCount } = await this.executor.run(query, [])
    return { count: rowCount, duration: 0 }
  }

  /** Release the connection — call via ctx.waitUntil() after the response. */
  async close() {
    await this.executor.close?.()
  }
}

/** postgres.js → PgExecutor (prod path; over Hyperdrive's connection string). */
function fromPostgresJs(sql: postgres.Sql): PgExecutor {
  const wrap = (s: postgres.Sql): PgExecutor => ({
    async run(query, params) {
      const rows = (await s.unsafe(query, params as never[])) as unknown as Record<string, unknown>[] & { count?: number }
      return { rows, rowCount: rows.count ?? rows.length }
    },
    begin: (fn) => s.begin((tx) => fn(wrap(tx as unknown as postgres.Sql))) as Promise<never>,
    close: () => sql.end({ timeout: 5 }),
  })
  return wrap(sql)
}

/** Build an Aquilla database handle from a Postgres connection string (prod). */
export function makePostgres(connectionString: string, max = 5): PostgresDb {
  const sql = postgres(connectionString, {
    max,
    fetch_types: false, // recommended through Hyperdrive's pooling
    types: {
      bigint: { to: 20, from: [20], parse: (x: string) => Number(x), serialize: (x: number | bigint) => String(x) },
      // SUM() over a bigint column (e.g. cell_audio.duration_ms) returns numeric
      // (oid 1700), not bigint — coerce it to a JS number too, else aggregates
      // come back as strings. Values are counts/ms/word-totals, all < 2^53.
      numeric: { to: 1700, from: [1700], parse: (x: string) => Number(x), serialize: (x: number) => String(x) },
      timestamp: { to: 1114, from: [1114, 1184], parse: (x: string) => x, serialize: (x: string) => x },
    },
  })
  return new PostgresDb(fromPostgresJs(sql))
}
